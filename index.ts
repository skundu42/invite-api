import dotenv from 'dotenv';
import express from 'express';
import { ethers } from 'ethers';
import { randomUUID } from 'crypto';
import Safe from '@safe-global/protocol-kit';
import pino from 'pino';

dotenv.config();

const api_key = process.env.API_KEY;
if (!api_key) throw new Error('API_KEY is not set');

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) throw new Error('PRIVATE_KEY is not set');
const SIGNER = privateKey;

const RPC_URL = 'https://rpc.gnosischain.com';
const INVITER_SAFE_ADDRESS = '0x20EcD8bDeb2F48d8a7c94E542aA4feC5790D9676';
const HUB_ADDRESS = '0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8';
const INVITATION_FARM_ADDRESS = '0xd28b7C4f148B1F1E190840A1f7A796C5525D8902';
const INVITATION_MODULE = '0x00738aca013B7B2e6cfE1690F0021C3182Fa40B5';
const DELAY_MODULE_ENDPOINT = 'https://gnosis-e702590.dedicated.hyperindex.xyz/v1/graphql';
const GNOSIS_PAY_GROUP_ADDRESS = '0xb629a1e86F3eFada0F87C83494Da8Cc34C3F84ef';
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
const CONFIRMATIONS_TO_WAIT = 5;
const MAX_QUEUE_LENGTH = 500;
const MAX_REQUESTS_PER_SECOND = 100;
const MAX_STORED_JOBS = 1000;
const JOB_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_INVITE_ATTEMPTS = 3;
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

const logger = pino({ level: LOG_LEVEL });
const rpcProvider = new ethers.JsonRpcProvider(RPC_URL);
const hubReadContract = new ethers.Contract(HUB_ADDRESS, HUB_ABI, rpcProvider);
const trustSignerWallet = new ethers.Wallet(SIGNER, rpcProvider);
const gnosisPayGroup = new ethers.Contract(GNOSIS_PAY_GROUP_ADDRESS, TRUST_GROUP_ABI, trustSignerWallet);
const invitationFarmInterface = new ethers.Interface(INVITATION_FARM_ABI);

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
  };
};

type OnboardJob = {
  id: string;
  address: string;
  safeAddress?: string | null;
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
const completedJobIds: string[] = [];

const app = express();
app.use(express.json());
app.use(logRequestReceived);
app.use((
  err: unknown,
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  if (err instanceof SyntaxError) {
    logger.warn({ err, path: req.path }, 'Malformed JSON body');
    return res.status(400).json({ message: 'Malformed JSON body' });
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
    return res.status(401).json({ message: 'Unauthorized' });
  }

  next();
}

function logRequestReceived(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction,
) {
  if (req.path === '/health') return next();

  const logContext: Record<string, unknown> = {
    method: req.method,
    path: req.path,
    queueLength: jobQueue.length,
  };

  if (req.method === 'POST' && typeof req.body?.address === 'string') {
    logContext.address = req.body.address;
  }

  logger.info(logContext, 'Request received');
  next();
}

app.post('/onboard', validateApiKey, async (req, res) => {
  try {
    if (isRateLimited()) {
      const message = 'Rate limit exceeded';
      logger.warn({ address: req.body?.address }, 'Rate limit exceeded');
      await notifySlack(`429 rate limit: ${message}`);
      return res.status(429).json({ message });
    }

    if (jobQueue.length >= MAX_QUEUE_LENGTH) {
      const message = 'Too many requests in queue, try again later';
      logger.warn({ queueLength: jobQueue.length }, 'Queue length exceeded');
      await notifySlack(`429 backpressure: ${message}`);
      return res.status(429).json({ message });
    }

    const { address } = req.body ?? {};

    if (typeof address !== 'string') {
      logger.warn({ body: req.body }, 'Invalid address payload');
      return res.status(400).json({ message: 'Invalid Ethereum address. Only checksum address allowed' });
    }

    let normalizedAddress: string;
    try {
      normalizedAddress = validateAndChecksumAddress(address);
    } catch (err) {
      logger.warn({ address }, 'Address validation failed');
      return res.status(400).json({
        message: err instanceof Error ? err.message : 'Invalid Ethereum address',
      });
    }

    const existingJob = findExistingJobForAddress(normalizedAddress);
    if (existingJob) {
      const statusCode = existingJob.status === 'confirmed' ? 200 : 202;
      logger.info({ jobId: existingJob.id, address: normalizedAddress, status: existingJob.status }, 'Existing job lookup');
      return res.status(statusCode).json(responseForJob(existingJob));
    }

    let safeAddress: string | null;
    let isHuman: boolean;

    try {
      [isHuman, safeAddress] = await Promise.all([
        checkIsHuman(normalizedAddress),
        fetchDelayModuleSafeAddress(normalizedAddress),
      ]);
    } catch (error) {
      logger.error({ err: error, address: normalizedAddress }, 'Eligibility checks failed. Address is either a human already or does not have a valid GP safe');
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Unable to process request. Address is either a human already or does not have a valid GP safe',
      });
    }

    if (isHuman) {
      logger.info({ address: normalizedAddress }, 'Address already human, skipping onboarding');
      return res.status(400).json({
        status: 'failed',
        message: 'Account is already verified as human',
      });
    }

    if (!safeAddress) {
      logger.info({ address: normalizedAddress }, 'DelayModule Safe not found for address');
      return res.status(400).json({
        status: 'failed',
        message: 'Account does not have a valid GP card',
      });
    }

    const job = enqueueJob(normalizedAddress, safeAddress);
    processQueue().catch(async (err) => {
      logger.error({ err }, 'Queue processor failed');
      await notifySlack(`Queue processor failure: ${err instanceof Error ? err.message : String(err)}`);
    });

    res.status(202).json(responseForJob(job));
  } catch (error) {
    logger.error({ err: error }, 'Unhandled onboard error');
    await notifySlack(`Unhandled onboard error: ${error instanceof Error ? error.message : String(error)}`);
    res.status(500).json({
      message: 'Unable to process request',
    });
  }
});

app.get('/status/:jobId', validateApiKey, (req, res) => {
  const job = jobsById.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ message: 'Job not found' });
  }

  res.status(200).json(responseForJob(job));
});

app.get('/health', (_req, res) => {
  res.status(200).json({ message: 'OK' });
});

app.use((
  err: unknown,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ message: 'Unable to process request' });
});

app.listen(3000, () => {
  logger.info('Server is running on port 3000');
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

function enqueueJob(address: string, safeAddress?: string | null): OnboardJob {
  const job: OnboardJob = {
    id: randomUUID(),
    address,
    safeAddress: safeAddress ?? null,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  jobsById.set(job.id, job);
  addressToJobId.set(address.toLowerCase(), job.id);
  jobQueue.push(job);
  logger.info({ jobId: job.id, address, queueLength: jobQueue.length }, 'Enqueued onboarding job');
  pruneStoredJobs();
  return job;
}

async function processQueue() {
  if (queueProcessorRunning) return;
  queueProcessorRunning = true;

  try {
    while (true) {
      const job = jobQueue.shift();
      if (!job) break;

      try {
        setJobStatus(job, 'processing');
        const result = await withTimeout(
          performOnboarding(job),
          JOB_TIMEOUT_MS,
          `Job ${job.id} (${job.address})`,
        );
        job.result = result;
        setJobStatus(job, 'confirmed');
      } catch (error) {
        job.error = error instanceof Error ? error.message : 'Unknown error';
        setJobStatus(job, 'failed');
        logger.error({ err: error, jobId: job.id, address: job.address, errorMessage: job.error }, 'Job failed');
        await notifySlack(`Job ${job.id} failed for ${job.address}: ${job.error}`);
      } finally {
        if (job.status === 'failed') {
          addressToJobId.delete(job.address.toLowerCase());
        }
      }
    }
  } finally {
    queueProcessorRunning = false;
    if (jobQueue.length > 0) {
      void processQueue();
    }
  }
}

function setJobStatus(job: OnboardJob, status: JobStatus) {
  const previousStatus = job.status;
  if (previousStatus !== status) {
    logger.info({
      jobId: job.id,
      address: job.address,
      previousStatus,
      status,
      queueLength: jobQueue.length,
    }, 'Job status updated');
  }
  job.status = status;
  job.updatedAt = Date.now();
  if (isTerminalStatus(status) && !isTerminalStatus(previousStatus)) {
    completedJobIds.push(job.id);
  }
  pruneStoredJobs();
}

function responseForJob(job: OnboardJob) {
  return {
    jobId: job.id,
    status: job.status,
    address: job.address,
    result: job.result ?? null,
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

function isTerminalStatus(status: JobStatus) {
  return status === 'confirmed' || status === 'failed';
}

function pruneStoredJobs() {
  const activeCount = jobsById.size - completedJobIds.length;
  const maxCompletedAllowed = Math.max(0, MAX_STORED_JOBS - activeCount);

  while (completedJobIds.length > maxCompletedAllowed) {
    const evictId = completedJobIds.shift();
    if (!evictId) break;
    const evictJob = jobsById.get(evictId);
    if (!evictJob) continue;

    jobsById.delete(evictId);
    addressToJobId.delete(evictJob.address.toLowerCase());
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, context: string): Promise<T> {
  let timeout: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${context} timed out after ${timeoutMs / 1000} seconds`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

async function performOnboarding(job: OnboardJob): Promise<JobResult> {
  const normalizedAddress = job.address;

  const safeAddress = job.safeAddress ?? await fetchDelayModuleSafeAddress(normalizedAddress);
  if (!safeAddress) throw new Error('Address has no associated Safe in DelayModule indexer');

  const invite = await claimInviteAndTransfer(normalizedAddress, CONFIRMATIONS_TO_WAIT);
  const txHashes = await trustGnosisPayGroup(normalizedAddress, CONFIRMATIONS_TO_WAIT);
  setJobStatus(job, 'submitted');

  logger.info({
    jobId: job.id,
    address: normalizedAddress,
    inviteId: invite?.inviteId ?? null,
    gnosisPayGroupTxHash: txHashes.gnosisPayGroupTxHash,
  }, 'Onboarding completed');

  return {
    address: normalizedAddress,
    isHuman: true,
    invite,
    transactions: {
      gnosisPayGroup: txHashes.gnosisPayGroupTxHash,
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
    logger.error({ err: error }, 'Failed to notify Slack');
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
): ethers.TransactionReceipt {
  if (!receipt) {
    throw new Error(`${context} transaction did not return a receipt`);
  }

  if (receipt.status !== 1) {
    throw new Error(`${context} transaction failed on-chain (status ${receipt.status})`);
  }

  return receipt;
}

async function checkIsHuman(address: string): Promise<boolean> {
  try {
    const humanStatus = await hubReadContract.isHuman(address);
    return Boolean(humanStatus);
  } catch (error) {
    logger.error({ err: error, address }, 'Failed to check human status');
    throw new Error('Unable to verify human status');
  }
}

async function claimInviteAndTransfer(address: string, confirmationsToWait: number) {
  return enqueueInviteTask(async () => {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_INVITE_ATTEMPTS; attempt++) {
      try {
        return await executeClaimInviteAndTransfer(address, confirmationsToWait);
      } catch (error) {
        lastError = error;
        logger.warn({
          err: error,
          address,
          attempt,
        }, attempt < MAX_INVITE_ATTEMPTS ? 'Invite claim attempt failed, retrying' : 'Invite claim attempt failed');
      }
    }

    const message = `Invite claim failed after ${MAX_INVITE_ATTEMPTS} attempts`;
    if (lastError instanceof Error) {
      throw new Error(`${message}: ${lastError.message}`);
    }

    throw new Error(message);
  });
}

async function executeClaimInviteAndTransfer(address: string, confirmationsToWait: number) {
  const claimInviteCalldata = invitationFarmInterface.encodeFunctionData('claimInvite', []);
  const returnData = await rpcProvider.call({
    to: INVITATION_FARM_ADDRESS,
    from: INVITER_SAFE_ADDRESS,
    data: claimInviteCalldata,
  });
  const [expectedInviteId] = invitationFarmInterface.decodeFunctionResult('claimInvite', returnData);
  const inviteId = expectedInviteId.toString();

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
  const txHash = (execution as any).hash as string;
  if (!txHash) {
    throw new Error('No transaction hash returned from Safe execution');
  }

  const receipt = await rpcProvider.waitForTransaction(txHash, confirmationsToWait);
  const combinedReceipt = ensureSuccessfulReceipt(receipt, 'Invite batch');

  return {
    inviteId,
    claimTxHash: combinedReceipt.hash,
    transferTxHash: combinedReceipt.hash,
  };
}

async function fetchDelayModuleSafeAddress(ownerAddress: string): Promise<string | null> {
  const query = `
    query DelayModuleByOwner($address: String) {
      Metri_Pay_DelayModule(where: { owners: { ownerAddress: { _eq: $address } } }) {
        safeAddress
      }
    }
  `;

  let response: Response;
  try {
    response = await fetch(DELAY_MODULE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { address: ownerAddress },
      }),
    });
  } catch (error) {
    logger.error({ err: error, address: ownerAddress }, 'DelayModule lookup failed to reach endpoint');
    throw new Error('Unable to verify Safe ownership');
  }

  if (!response.ok) {
    const body = await response.text();
    logger.error({
      address: ownerAddress,
      status: response.status,
      statusText: response.statusText,
      body,
    }, 'DelayModule lookup HTTP error');
    throw new Error('Unable to verify Safe ownership');
  }

  const json = await response.json() as {
    data?: { Metri_Pay_DelayModule?: Array<{ safeAddress?: string | null }> };
    errors?: unknown;
  };

  if (json.errors) {
    logger.error({ errors: json.errors, address: ownerAddress }, 'DelayModule lookup GraphQL error');
    throw new Error('Unable to verify Safe ownership');
  }

  const modules = json.data?.Metri_Pay_DelayModule ?? [];
  const match = modules.find((module) => typeof module.safeAddress === 'string' && module.safeAddress.length > 0);
  return match?.safeAddress ?? null;
}

async function trustGnosisPayGroup(address: string, confirmationsToWait: number) {
  const members = [address];

  const { gnosisPayGroupTx } = await enqueueNonceTask(async () => {
    const baseNonce = await rpcProvider.getTransactionCount(trustSignerWallet.address, 'pending');
    const gnosisTx = await gnosisPayGroup.trustBatchWithConditions(members, TRUST_EXPIRY, {
      nonce: baseNonce,
    });

    return {
      gnosisPayGroupTx: gnosisTx,
    };
  });

  const gnosisPayGroupReceipt = await gnosisPayGroupTx.wait(confirmationsToWait);

  ensureSuccessfulReceipt(gnosisPayGroupReceipt, 'Gnosis Pay trust');

  return {
    gnosisPayGroupTxHash: gnosisPayGroupTx.hash,
  };
}
