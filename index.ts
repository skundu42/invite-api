import dotenv from 'dotenv';
import express from 'express';
import { ethers } from 'ethers';
//import Safe from '@safe-global/protocol-kit';

dotenv.config();

const api_key = process.env.API_KEY;
if (!api_key) throw new Error('API_KEY is not set');

const trustPrivateKey = process.env.TRUST_PRIVATE_KEY;
if (!trustPrivateKey) throw new Error('TRUST_PRIVATE_KEY is not set');
const TRUST_SIGNER = trustPrivateKey;

const RPC_URL = 'https://rpc.gnosischain.com';
const HUB_ADDRESS = '0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8';
const GNOSIS_PAY_GROUP_ADDRESS = '0xb629a1e86F3eFada0F87C83494Da8Cc34C3F84ef';
const DUBLIN_GROUP_ADDRESS = '0xAeCda439CC8Ac2a2da32bE871E0C2D7155350f80';
const TRUST_EXPIRY = BigInt('79228162514264337593543950335'); 
const TRUST_GROUP_ABI = ['function trustBatchWithConditions(address[] _members, uint96 _expiry) public'];

const rpcProvider = new ethers.JsonRpcProvider(RPC_URL);
const trustSignerWallet = new ethers.Wallet(TRUST_SIGNER, rpcProvider);
const gnosisPayGroup = new ethers.Contract(GNOSIS_PAY_GROUP_ADDRESS, TRUST_GROUP_ABI, trustSignerWallet);
const dublinGroup = new ethers.Contract(DUBLIN_GROUP_ADDRESS, TRUST_GROUP_ABI, trustSignerWallet);

let nonceQueue: Promise<void> = Promise.resolve();

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

    const txHashes = await trustAcrossGroups(normalizedAddress);

    res.status(200).json({
      address: normalizedAddress,
      transactions: {
        gnosisPayGroup: txHashes.gnosisPayGroupTxHash,
        dublinGroup: txHashes.dublinGroupTxHash,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
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

function enqueueNonceTask<T>(task: () => Promise<T>): Promise<T> {
  const run = nonceQueue.then(task);
  nonceQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function trustAcrossGroups(address: string) {
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
    gnosisPayGroupTx.wait(10),
    dublinGroupTx.wait(10),
  ]);

  if (gnosisPayGroupReceipt?.status !== 1 || dublinGroupReceipt?.status !== 1) {
    throw new Error('One of the trust transactions failed or was reverted');
  }


  return {
    gnosisPayGroupTxHash: gnosisPayGroupTx.hash,
    dublinGroupTxHash: dublinGroupTx.hash,
  };
}
