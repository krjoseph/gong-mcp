# Gong MCP Server

A Model Context Protocol (MCP) server that provides access to Gong's API for retrieving call recordings and transcripts. This server allows Claude to interact with Gong data through a standardized interface.

## Features

- List Gong calls with optional date range filtering
- Retrieve detailed transcripts for specific calls
- Secure authentication using Gong's API credentials
- Standardized MCP interface for easy integration with Claude
- **Dual transport support**: stdio (for local/CLI usage) and streamable-http (for HTTP/web deployments)

## Prerequisites

- Node.js 18 or higher
- Docker (optional, for containerized deployment)
- Gong API credentials (Access Key and Secret)

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GONG_ACCESS_KEY` | Conditional* | - | Your Gong API access key |
| `GONG_ACCESS_SECRET` | Conditional* | - | Your Gong API access secret |
| `GONG_API_URL` | No | `https://api.gong.io/v2` | Gong API base URL |
| `MCP_TRANSPORT` | No | `stdio` | Transport mode: `stdio` or `streamable-http` |
| `PORT` | No | `3000` | HTTP server port (only for `streamable-http` mode) |
| `HOST` | No | `127.0.0.1` | HTTP server host (only for `streamable-http` mode) |

\* **Required for stdio transport**. Optional for streamable-http transport when using bring-your-own-token (see below).

## Installation

### Local Development

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create environment file from example:
   ```bash
   cp .env.example .env
   ```
   Then edit `.env` and add your Gong API credentials.
   
4. Build the project:
   ```bash
   npm run build
   ```

### Docker

Build the container:
```bash
docker build -t gong-mcp .
```

## Architecture

The Gong MCP server supports two transport modes:

```
┌─────────────────────────────────────────────────────────────┐
│                    Gong MCP Server                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐        ┌──────────────┐                 │
│  │  Stdio       │        │ Streamable   │                 │
│  │  Transport   │        │ HTTP         │                 │
│  └──────┬───────┘        └──────┬───────┘                 │
│         │                       │                          │
│         │  stdin/stdout         │  HTTP/SSE                │
│         │                       │                          │
└─────────┼───────────────────────┼──────────────────────────┘
          │                       │
          │                       │
    ┌─────▼──────┐          ┌────▼────────┐
    │   Claude   │          │   HTTP      │
    │  Desktop   │          │   Clients   │
    └────────────┘          └─────────────┘
                            (Web, Cloud, etc)
```

## Usage

The server supports two transport modes. For detailed information about each transport mode, see [TRANSPORT-GUIDE.md](./TRANSPORT-GUIDE.md).

### 1. Stdio Transport (Default)

Use stdio transport for local development and Claude Desktop integration:

```bash
# Using built JavaScript
node dist/index.js

# Or via npm
npm start
```

### 2. Streamable HTTP Transport

Use HTTP transport for web deployments, cloud hosting, and REST API access:

```bash
# Set environment variable
MCP_TRANSPORT=streamable-http PORT=3000 HOST=127.0.0.1 node dist/index.js

# Or with custom port/host
MCP_TRANSPORT=streamable-http PORT=8080 HOST=0.0.0.0 node dist/index.js
```

**Endpoints when using HTTP transport:**
- `POST /mcp` - JSON-RPC requests
- `GET /mcp` - Server-Sent Events (SSE) streaming
- `GET /health` - Health check endpoint

#### Bring Your Own Token (BYOT)

When using streamable-http transport, you can provide a Gong access token via the `Authorization` header instead of using environment variables:

```bash
# Start server without credentials (BYOT mode)
MCP_TRANSPORT=streamable-http PORT=3000 node dist/index.js

# Make requests with Bearer token
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GONG_TOKEN" \
  -H "Mcp-Session-Id: session-123" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "list_calls",
      "arguments": {}
    }
  }'
```

**BYOT Benefits:**
- ✅ Multi-tenant support - each request can use a different token
- ✅ No need to restart server when credentials change
- ✅ Better security isolation between users
- ✅ Ideal for web applications where users authenticate separately

📘 **See [BYOT-GUIDE.md](./BYOT-GUIDE.md) for comprehensive documentation, examples, and best practices.**

🔒 **Security:** Tokens and clients are **never cached** across requests. See [SECURITY-AUDIT.md](./SECURITY-AUDIT.md) for details.

## Configuring Claude Desktop

### Using Stdio Transport (Recommended for local use)

1. Open Claude Desktop settings
2. Navigate to the MCP Servers section
3. Add a new server with the following configuration:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/gong-mcp/dist/index.js"],
  "env": {
    "GONG_ACCESS_KEY": "your_access_key_here",
    "GONG_ACCESS_SECRET": "your_access_secret_here"
  }
}
```

### Using Docker with Stdio

```json
{
  "command": "docker",
  "args": [
    "run",
    "-it",
    "--rm",
    "gong-mcp"
  ],
  "env": {
    "GONG_ACCESS_KEY": "your_access_key_here",
    "GONG_ACCESS_SECRET": "your_access_secret_here"
  }
}
```

### Using HTTP Transport

For HTTP transport, Claude can connect to the running server:

1. Start the server:
   ```bash
   MCP_TRANSPORT=streamable-http PORT=3000 \
   GONG_ACCESS_KEY=your_key \
   GONG_ACCESS_SECRET=your_secret \
   node dist/index.js
   ```

2. Configure Claude to connect to `http://localhost:3000/mcp`

**Note:** Replace placeholder credentials with your actual Gong API credentials.

## Testing

### Testing HTTP Transport

A test script is provided to verify the streamable-http transport is working:

```bash
# Start the server in HTTP mode
MCP_TRANSPORT=streamable-http PORT=3000 \
GONG_ACCESS_KEY=your_key \
GONG_ACCESS_SECRET=your_secret \
node dist/index.js

# In another terminal, run the test script
./test-http.sh 3000
```

The test script will:
1. Check the health endpoint
2. Initialize an MCP session
3. List available tools

### Testing BYOT Mode

Test bring-your-own-token authentication:

```bash
# Start the server WITHOUT credentials (BYOT mode)
MCP_TRANSPORT=streamable-http PORT=3000 node dist/index.js

# In another terminal, run the BYOT test script with your token
./test-byot.sh 3000 YOUR_GONG_ACCESS_TOKEN
```

The BYOT test script will:
1. Check the health endpoint
2. Initialize an MCP session with Bearer token
3. List available tools with Bearer token
4. Call the list_calls tool with Bearer token

### Testing Stdio Transport

To test stdio transport:

```bash
# Start the server (stdio is the default)
GONG_ACCESS_KEY=your_key \
GONG_ACCESS_SECRET=your_secret \
node dist/index.js
```

The server will communicate via stdin/stdout.

## Deployment

### Docker with HTTP Transport

Create a `Dockerfile` for HTTP deployment:

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist ./dist

ENV MCP_TRANSPORT=streamable-http
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

CMD ["node", "dist/index.js"]
```

Build and run:

```bash
docker build -t gong-mcp-http .
docker run -p 3000:3000 \
  -e GONG_ACCESS_KEY=your_key \
  -e GONG_ACCESS_SECRET=your_secret \
  gong-mcp-http
```

### Cloud Platforms

The HTTP transport mode makes it easy to deploy to cloud platforms:

**Heroku:**
```bash
heroku create your-gong-mcp
heroku config:set MCP_TRANSPORT=streamable-http
heroku config:set GONG_ACCESS_KEY=your_key
heroku config:set GONG_ACCESS_SECRET=your_secret
git push heroku main
```

**AWS ECS/Fargate, Google Cloud Run, Azure Container Instances:**
- Use the Docker image with HTTP transport
- Set environment variables in your platform's configuration
- Expose port 3000 (or your custom PORT)

**Railway, Render, Fly.io:**
- Connect your GitHub repository
- Set `MCP_TRANSPORT=streamable-http` in environment variables
- Configure port 3000 (or custom PORT)

## Available Tools

### List Calls

Retrieves a list of Gong calls with optional date range filtering.

```typescript
{
  name: "list_calls",
  description: "List Gong calls with optional date range filtering. Returns call details including ID, title, start/end times, participants, and duration.",
  inputSchema: {
    type: "object",
    properties: {
      fromDateTime: {
        type: "string",
        description: "Start date/time in ISO format (e.g. 2024-03-01T00:00:00Z)"
      },
      toDateTime: {
        type: "string",
        description: "End date/time in ISO format (e.g. 2024-03-31T23:59:59Z)"
      }
    }
  }
}
```

### Retrieve Transcripts

Retrieves detailed transcripts for specified call IDs.

```typescript
{
  name: "retrieve_transcripts",
  description: "Retrieve transcripts for specified call IDs. Returns detailed transcripts including speaker IDs, topics, and timestamped sentences.",
  inputSchema: {
    type: "object",
    properties: {
      callIds: {
        type: "array",
        items: { type: "string" },
        description: "Array of Gong call IDs to retrieve transcripts for"
      }
    },
    required: ["callIds"]
  }
}
```

## License

MIT License - see LICENSE file for details

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request 
