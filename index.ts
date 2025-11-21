import dotenv from 'dotenv';
import express from 'express';
import { ethers } from 'ethers';
import Safe from '@safe-global/protocol-kit';

dotenv.config();

const api_key = process.env.API_KEY;
if (!api_key) throw new Error('API_KEY is not set');

const trustPrivateKey = process.env.TRUST_PRIVATE_KEY;
if (!trustPrivateKey) throw new Error('TRUST_PRIVATE_KEY is not set');
const TRUST_SIGNER = trustPrivateKey;

const RPC_URL = 'https://1rpc.io/gnosis';
const HUB_ADDRESS = '0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8';
const TRUST_SAFE_ADDRESS = '0xb59Eb7D8dc6CFb34e6069c995c5323CE76254143';
const rpcProvider = new ethers.JsonRpcProvider(RPC_URL);
const trustSignerWallet = new ethers.Wallet(TRUST_SIGNER, rpcProvider);
const TRUST_SIGNER_ADDRESS = trustSignerWallet.address;



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


    res.status(200).json({ message: 'Okay' });
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

function ensureValidTrustee(address: string) {
  if (!ethers.isAddress(address)) {
    throw new Error('Invalid trustee address');
  }
}
