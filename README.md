# Invite API

## Prerequisites
- Node.js 18+ recommended
- npm
- Access to the configured Gnosis Chain RPC 

## Configuration
Create a `.env` file in the project root:

```
API_KEY=                
PRIVATE_KEY=            
SLACK_WEBHOOK_URL= 
```

## Install & Run
```
npm install
npm run dev    
# or
npm start       
```

The server listens on `http://localhost:3000`.

## Rate limits & queueing
- 100 requests/sec token bucket.
- Max 500 queued jobs; additional requests receive HTTP 429.
- Jobs time out after 5 minutes; failures can be retried by resubmitting the same address.

## API

### POST /onboard
Queues an address for onboarding.

Headers:
- `Content-Type: application/json`
- `x-api-key: $API_KEY`

Body:
```
{ "address": "0xabc123... (checksum address)" }
```


Example:
```
curl -X POST http://localhost:3000/onboard \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"address":"0x742d35Cc6634C0532925a3b844Bc454e4438f44e"}'
```

- Success enqueues a job and returns `202 Accepted`. If the same address already has a job, returns that job with `200` when confirmed or `202` while pending.
- Invalid address → `400`.
- Address already marked human → `400` with `status: "failed"`.
- Address without a DelayModule Safe → `400` with `status: "failed"`.
- Backpressure (rate/queue) → `429`.
- Unexpected server error → `500`.

Job payload shape:
```
{
  "jobId": "uuid",
  "status": "queued | processing | submitted | confirmed | failed",
  "address": "0x...",
  "result": {
    "isHuman": true,
    "invite": {
      "inviteId": "123",
      "claimTxHash": "0x...",
      "transferTxHash": "0x..."
    },
    "transactions": {
      "gnosisPayGroup": "0x..."
    },
    "address": "0x..."
  } | null,
  "createdAt": 1730000000000,
  "updatedAt": 1730000005000
}
```
`result` is `null` until the job finishes or fails.

### GET /status/:jobId
Polls a job created by `/onboard`.

- Headers:
  - `x-api-key: $API_KEY`

- `200 OK` with the job payload.
- `404 Not Found` if the `jobId` is unknown.

Example:
```
curl http://localhost:3000/status/5e9a8c7d-3c6f-4b5e-a9d4-123456789abc \
  -H "x-api-key: $API_KEY"
```

### GET /health
Simple readiness probe.

- `200 OK` and `{ "message": "OK" }`
