import dotenv from 'dotenv';
import express from 'express';
import { ethers } from 'ethers';
import { randomUUID } from 'crypto';
import Safe from '@safe-global/protocol-kit';

dotenv.config();

const api_key = process.env.API_KEY;
if (!api_key) throw new Error('API_KEY is not set');

const trustPrivateKey = process.env.TRUST_PRIVATE_KEY;
if (!trustPrivateKey) throw new Error('TRUST_PRIVATE_KEY is not set');
const SIGNER = trustPrivateKey;

const RPC_URL = 'https://rpc.gnosischain.com';
const INVITER_SAFE_ADDRESS = '0x20EcD8bDeb2F48d8a7c94E542aA4feC5790D9676';
const HUB_ADDRESS = '0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8';
const INVITATION_FARM_ADDRESS = '0xd28b7C4f148B1F1E190840A1f7A796C5525D8902';
const INVITATION_MODULE = '0x00738aca013B7B2e6cfE1690F0021C3182Fa40B5';
const GNOSIS_PAY_GROUP_ADDRESS = '0xb629a1e86F3eFada0F87C83494Da8Cc34C3F84ef';
const DUBLIN_GROUP_ADDRESS = '0xAeCda439CC8Ac2a2da32bE871E0C2D7155350f80';
const TRUST_EXPIRY = BigInt('79228162514264337593543950335');
const TRUST_GROUP_ABI = ['function trustBatchWithConditions(address[] _members, uint96 _expiry) public'];
const INVITATION_FARM_ABI = [
  'function claimInvite() external returns (uint256 id)',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
];
const HUB_ABI = [
  'function safeTransferFrom(address, address, uint256, uint256, bytes)',
  'function isHuman(address _account) external view returns (bool)',
];
const INVITE_AMOUNT = ethers.parseUnits('96', 18);
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const CONFIRMATIONS_TO_WAIT = 10;
const MAX_QUEUE_LENGTH = 500;
const MAX_REQUESTS_PER_SECOND = 100;

const rpcProvider = new ethers.JsonRpcProvider(RPC_URL);
const hubReadContract = new ethers.Contract(HUB_ADDRESS, HUB_ABI, rpcProvider);
const trustSignerWallet = new ethers.Wallet(SIGNER, rpcProvider);
const gnosisPayGroup = new ethers.Contract(GNOSIS_PAY_GROUP_ADDRESS, TRUST_GROUP_ABI, trustSignerWallet);
const dublinGroup = new ethers.Contract(DUBLIN_GROUP_ADDRESS, TRUST_GROUP_ABI, trustSignerWallet);
const invitationFarmInterface = new ethers.Interface(INVITATION_FARM_ABI);
const transferSingleTopic = invitationFarmInterface.getEvent('TransferSingle')?.topicHash;

let inviterSafeInstance: unknown | null = null;
let inviterSafeInitPromise: Promise<unknown> | null = null;

let nonceQueue: Promise<void> = Promise.resolve();
let inviteQueue: Promise<void> = Promise.resolve();

type JobStatus = 'queued' | 'processing' | 'submitted' | 'confirmed' | 'failed';

type JobResult = {
  address: string;
  isHuman: boolean;
  invite: {
    inviteId: string;
    claimTxHash: string;
    transferTxHash: string;
  } | null;
  transactions: {
    gnosisPayGroup: string;
    dublinGroup: string;
  };
};

type OnboardJob = {
  id: string;
  address: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  result?: JobResult;
  error?: string;
};

const jobsById = new Map<string, OnboardJob>();
const addressToJobId = new Map<string, string>();
const jobQueue: OnboardJob[] = [];
let queueProcessorRunning = false;
let rateLimitTokens = MAX_REQUESTS_PER_SECOND;
let lastRefillTimestamp = Date.now();

const app = express();
app.use(express.json());
app.use((
  err: unknown,
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  if (err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  next(err);
});

function validateApiKey(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || apiKey !== api_key) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

app.post('/onboard', validateApiKey, async (req, res) => {
  try {
    if (isRateLimited()) {
      const message = 'Rate limit exceeded';
      await notifySlack(`429 rate limit: ${message}`);
      return res.status(429).json({ error: message });
    }

    if (jobQueue.length >= MAX_QUEUE_LENGTH) {
      const message = 'Too many requests in queue, try again later';
      await notifySlack(`429 backpressure: ${message}`);
      return res.status(429).json({ error: message });
    }

    const { address } = req.body ?? {};

    if (typeof address !== 'string') {
      return res.status(400).json({ error: 'Invalid Ethereum address. Only checksum address allowed' });
    }

    let normalizedAddress: string;
    try {
      normalizedAddress = validateAndChecksumAddress(address);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Invalid Ethereum address',
      });
    }

    const existingJob = findExistingJobForAddress(normalizedAddress);
    if (existingJob) {
      const statusCode = existingJob.status === 'confirmed' ? 200 : 202;
      return res.status(statusCode).json(responseForJob(existingJob));
    }

    const job = enqueueJob(normalizedAddress);
    processQueue().catch(async (err) => {
      console.error('Queue processor failed', err);
      await notifySlack(`Queue processor failure: ${err instanceof Error ? err.message : String(err)}`);
    });

    res.status(202).json(responseForJob(job));
  } catch (error) {
    console.error(error);
    await notifySlack(`Unhandled onboard error: ${error instanceof Error ? error.message : String(error)}`);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

app.get('/status/:jobId', (req, res) => {
  const job = jobsById.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.status(200).json(responseForJob(job));
});

app.get('/health', (_req, res) => {
  res.status(200).json({ message: 'OK' });
});

app.listen(3000, () => {
  console.log('Server is running on port 3000');
});

function validateAndChecksumAddress(address: string) {
  try {
    return ethers.getAddress(address);
  } catch {
    throw new Error('Invalid Ethereum address');
  }
}

function isRateLimited(): boolean {
  const now = Date.now();
  const elapsedMs = now - lastRefillTimestamp;
  const refill = (elapsedMs / 1000) * MAX_REQUESTS_PER_SECOND;
  rateLimitTokens = Math.min(MAX_REQUESTS_PER_SECOND, rateLimitTokens + refill);
  lastRefillTimestamp = now;

  if (rateLimitTokens < 1) {
    return true;
  }

  rateLimitTokens -= 1;
  return false;
}

function enqueueJob(address: string): OnboardJob {
  const job: OnboardJob = {
    id: randomUUID(),
    address,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  jobsById.set(job.id, job);
  addressToJobId.set(address.toLowerCase(), job.id);
  jobQueue.push(job);
  return job;
}

async function processQueue() {
  if (queueProcessorRunning) return;
  queueProcessorRunning = true;

  while (jobQueue.length > 0) {
    const job = jobQueue.shift();
    if (!job) break;

    try {
      setJobStatus(job, 'processing');
      const result = await performOnboarding(job);
      job.result = result;
      setJobStatus(job, 'confirmed');
    } catch (error) {
      job.error = error instanceof Error ? error.message : 'Unknown error';
      setJobStatus(job, 'failed');
      console.error('Job failed', job.id, job.error);
      await notifySlack(`Job ${job.id} failed for ${job.address}: ${job.error}`);
    } finally {
      if (job.status === 'failed') {
        addressToJobId.delete(job.address.toLowerCase());
      }
    }
  }

  queueProcessorRunning = false;
}

function setJobStatus(job: OnboardJob, status: JobStatus) {
  job.status = status;
  job.updatedAt = Date.now();
}

function responseForJob(job: OnboardJob) {
  return {
    jobId: job.id,
    status: job.status,
    address: job.address,
    result: job.result ?? null,
    error: job.error ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function findExistingJobForAddress(address: string) {
  const jobId = addressToJobId.get(address.toLowerCase());
  if (!jobId) return null;
  const job = jobsById.get(jobId);
  if (!job) return null;

  if (job.status === 'failed') {
    addressToJobId.delete(address.toLowerCase());
    return null;
  }

  return job;
}

async function performOnboarding(job: OnboardJob): Promise<JobResult> {
  const normalizedAddress = job.address;

  const isHuman = await checkIsHuman(normalizedAddress);
  const txHashes = await trustAcrossGroups(normalizedAddress, CONFIRMATIONS_TO_WAIT);
  setJobStatus(job, 'submitted');

  const invite = isHuman ? null : await claimInviteAndTransfer(normalizedAddress, CONFIRMATIONS_TO_WAIT);

  return {
    address: normalizedAddress,
    isHuman,
    invite,
    transactions: {
      gnosisPayGroup: txHashes.gnosisPayGroupTxHash,
      dublinGroup: txHashes.dublinGroupTxHash,
    },
  };
}

async function notifySlack(message: string) {
  if (!SLACK_WEBHOOK_URL) return;

  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
  } catch (error) {
    console.error('Failed to notify Slack', error);
  }
}

function enqueueNonceTask<T>(task: () => Promise<T>): Promise<T> {
  const run = nonceQueue.then(task);
  nonceQueue = run.then(() => undefined, () => undefined);
  return run;
}

function enqueueInviteTask<T>(task: () => Promise<T>): Promise<T> {
  const run = inviteQueue.then(task);
  inviteQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function getInviterSafe(): Promise<any> {
  if (inviterSafeInstance) return inviterSafeInstance;
  if (!inviterSafeInitPromise) {
    inviterSafeInitPromise = (Safe as unknown as { init: (config: unknown) => Promise<unknown> }).init({
      provider: RPC_URL,
      signer: SIGNER,
      safeAddress: INVITER_SAFE_ADDRESS,
    });
  }

  inviterSafeInstance = await inviterSafeInitPromise;
  return inviterSafeInstance;
}

function ensureSuccessfulReceipt(
  receipt: ethers.TransactionReceipt | null | undefined,
  context: string,
) {
  if (!receipt) {
    throw new Error(`${context} transaction did not return a receipt`);
  }

  return receipt;
}

async function checkIsHuman(address: string): Promise<boolean> {
  try {
    const humanStatus = await hubReadContract.isHuman(address);
    return Boolean(humanStatus);
  } catch (error) {
    console.error(`Failed to check human status for ${address}`, error);
    throw new Error('Unable to verify human status');
  }
}

function extractInviteIdFromReceipt(receipt: ethers.TransactionReceipt) {
  if (!transferSingleTopic) {
    throw new Error('TransferSingle topic unavailable');
  }

  const log = receipt.logs.find(
    (entry) =>
      entry.address.toLowerCase() === INVITATION_FARM_ADDRESS.toLowerCase()
      && entry.topics[0] === transferSingleTopic,
  );

  if (!log) {
    throw new Error('Invite id not found in receipt');
  }

  const parsed = invitationFarmInterface.parseLog(log);
  if (!parsed?.args?.id) {
    throw new Error('Invite id missing from receipt');
  }

  return parsed.args.id.toString();
}

async function claimInviteAndTransfer(address: string, confirmationsToWait: number) {
  return enqueueInviteTask(async () => {
    const claimInviteCalldata = invitationFarmInterface.encodeFunctionData('claimInvite', []);
    const returnData = await rpcProvider.call({
      to: INVITATION_FARM_ADDRESS,
      from: INVITER_SAFE_ADDRESS,
      data: claimInviteCalldata,
    });
    const [expectedInviteId] = invitationFarmInterface.decodeFunctionResult('claimInvite', returnData);

    const transferData = ethers.AbiCoder.defaultAbiCoder().encode(['address'], [address]);
    const hubInterface = new ethers.Interface(HUB_ABI);
    const transferTxData = hubInterface.encodeFunctionData('safeTransferFrom', [
      INVITER_SAFE_ADDRESS,
      INVITATION_MODULE,
      expectedInviteId,
      INVITE_AMOUNT,
      transferData,
    ]);

    const safe = await getInviterSafe();
    const safeTx = await safe.createTransaction({
      transactions: [
        { to: INVITATION_FARM_ADDRESS, data: claimInviteCalldata, value: '0' },
        { to: HUB_ADDRESS, data: transferTxData, value: '0' },
      ],
    });

    const execution = await safe.executeTransaction(safeTx);
    const txResponse = execution.transactionResponse as ethers.TransactionResponse | undefined;

    if (!txResponse) {
      throw new Error('No transaction response returned from Safe execution');
    }

    const combinedReceipt = ensureSuccessfulReceipt(await txResponse.wait(confirmationsToWait), 'Invite batch');
    const inviteId = extractInviteIdFromReceipt(combinedReceipt);

    if (inviteId !== expectedInviteId.toString()) {
      throw new Error(`Invite id mismatch. Expected ${expectedInviteId.toString()}, got ${inviteId}`);
    }

    return {
      inviteId,
      claimTxHash: combinedReceipt.hash,
      transferTxHash: combinedReceipt.hash,
    };
  });
}

async function trustAcrossGroups(address: string, confirmationsToWait: number) {
  const members = [address];

  const { gnosisPayGroupTx, dublinGroupTx } = await enqueueNonceTask(async () => {
    const baseNonce = await rpcProvider.getTransactionCount(trustSignerWallet.address, 'pending');
    const gnosisTx = await gnosisPayGroup.trustBatchWithConditions(members, TRUST_EXPIRY, {
      nonce: baseNonce,
    });
    const dublinTx = await dublinGroup.trustBatchWithConditions(members, TRUST_EXPIRY, {
      nonce: baseNonce + 1,
    });

    return {
      gnosisPayGroupTx: gnosisTx,
      dublinGroupTx: dublinTx,
    };
  });

  const [gnosisPayGroupReceipt, dublinGroupReceipt] = await Promise.all([
    gnosisPayGroupTx.wait(confirmationsToWait),
    dublinGroupTx.wait(confirmationsToWait),
  ]);

  ensureSuccessfulReceipt(gnosisPayGroupReceipt, 'Gnosis Pay trust');
  ensureSuccessfulReceipt(dublinGroupReceipt, 'Dublin trust');


  return {
    gnosisPayGroupTxHash: gnosisPayGroupTx.hash,
    dublinGroupTxHash: dublinGroupTx.hash,
  };
}
