#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';
import dotenv from 'dotenv';
import crypto from 'crypto';
import express from 'express';
import { randomUUID } from 'crypto';

// Redirect all console output to stderr (only for stdio mode)
const originalConsole = { ...console };
const redirectConsole = () => {
  console.log = (...args) => originalConsole.error(...args);
  console.info = (...args) => originalConsole.error(...args);
  console.warn = (...args) => originalConsole.error(...args);
};

dotenv.config();

const GONG_API_URL = process.env.GONG_API_URL || 'https://api.gong.io/v2';
const GONG_ACCESS_KEY = process.env.GONG_ACCESS_KEY;
const GONG_ACCESS_SECRET = process.env.GONG_ACCESS_SECRET;

// For stdio mode, credentials are required
// For HTTP mode with BYOT, credentials are optional
const isHttpMode = process.env.MCP_TRANSPORT === 'streamable-http';
if (!isHttpMode && (!GONG_ACCESS_KEY || !GONG_ACCESS_SECRET)) {
  console.error("Error: GONG_ACCESS_KEY and GONG_ACCESS_SECRET environment variables are required for stdio transport");
  process.exit(1);
}

// Type definitions
interface GongCall {
  id: string;
  title: string;
  scheduled?: string;
  started?: string;
  duration?: number;
  direction?: string;
  system?: string;
  scope?: string;
  media?: string;
  language?: string;
  url?: string;
}

interface GongTranscript {
  speakerId: string;
  topic?: string;
  sentences: Array<{
    start: number;
    text: string;
  }>;
}

interface GongCallTranscript {
  callId: string;
  transcript: GongTranscript[];
}

interface GongListCallsResponse {
  calls: GongCall[];
}

interface GongRetrieveTranscriptsResponse {
  callTranscripts: GongCallTranscript[];
}

interface GongListCallsArgs {
  [key: string]: string | undefined;
  fromDateTime?: string;
  toDateTime?: string;
}

interface GongRetrieveTranscriptsArgs {
  callIds: string[];
}

interface GongSearchTranscriptsArgs {
  searchText: string;
  fromDateTime?: string;
  toDateTime?: string;
  maxResults?: number;
}

// Gong API Client
class GongClient {
  private accessKey?: string;
  private accessSecret?: string;
  private bearerToken?: string;

  constructor(accessKey?: string, accessSecret?: string, bearerToken?: string) {
    this.accessKey = accessKey;
    this.accessSecret = accessSecret;
    this.bearerToken = bearerToken;
  }

  private async generateSignature(method: string, path: string, timestamp: string, params?: unknown): Promise<string> {
    if (!this.accessSecret) {
      throw new Error('Access secret is required for signature generation');
    }
    
    const stringToSign = `${method}\n${path}\n${timestamp}\n${params ? JSON.stringify(params) : ''}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(this.accessSecret);
    const messageData = encoder.encode(stringToSign);
    
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    const signature = await crypto.subtle.sign(
      'HMAC',
      cryptoKey,
      messageData
    );
    
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  private async request<T>(method: string, path: string, params?: Record<string, string | undefined>, data?: Record<string, unknown>): Promise<T> {
    const url = `${GONG_API_URL}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Use Bearer token if provided, otherwise use API key/secret
    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    } else if (this.accessKey && this.accessSecret) {
      const timestamp = new Date().toISOString();
      headers['Authorization'] = `Basic ${Buffer.from(`${this.accessKey}:${this.accessSecret}`).toString('base64')}`;
      headers['X-Gong-AccessKey'] = this.accessKey;
      headers['X-Gong-Timestamp'] = timestamp;
      headers['X-Gong-Signature'] = await this.generateSignature(method, path, timestamp, data || params);
    } else {
      throw new Error('Either bearer token or access key/secret must be provided');
    }
    
    const response = await axios({
      method,
      url,
      params,
      data,
      headers
    });

    return response.data as T;
  }

  async listCalls(fromDateTime?: string, toDateTime?: string): Promise<GongListCallsResponse> {
    const params: GongListCallsArgs = {};
    if (fromDateTime) params.fromDateTime = fromDateTime;
    if (toDateTime) params.toDateTime = toDateTime;

    return this.request<GongListCallsResponse>('GET', '/calls', params);
  }

  async retrieveTranscripts(callIds: string[]): Promise<GongRetrieveTranscriptsResponse> {
    return this.request<GongRetrieveTranscriptsResponse>('POST', '/calls/transcript', undefined, {
      filter: {
        callIds,
        includeEntities: true,
        includeInteractionsSummary: true,
        includeTrackers: true
      }
    });
  }

  async searchTranscripts(searchText: string, fromDateTime?: string, toDateTime?: string, maxResults: number = 50): Promise<any> {
    // Step 1: Get calls within date range
    const callsResponse = await this.listCalls(fromDateTime, toDateTime);
    
    if (!callsResponse.calls || callsResponse.calls.length === 0) {
      return { matches: [], totalCalls: 0, searchedCalls: 0 };
    }

    // Step 2: Get transcripts for these calls (in batches to avoid overwhelming the API)
    const callIds = callsResponse.calls.slice(0, Math.min(100, maxResults * 2)).map(call => call.id);
    const transcriptsResponse = await this.retrieveTranscripts(callIds);

    // Step 3: Search through transcripts
    const searchLower = searchText.toLowerCase();
    const matches: any[] = [];

    for (const callTranscript of transcriptsResponse.callTranscripts || []) {
      // Find the corresponding call info
      const call = callsResponse.calls.find(c => c.id === callTranscript.callId);
      
      // Search through all transcripts for this call
      for (const transcript of callTranscript.transcript) {
        const matchingSentences = transcript.sentences.filter(sentence => 
          sentence.text.toLowerCase().includes(searchLower)
        );

        if (matchingSentences.length > 0) {
          matches.push({
            callId: callTranscript.callId,
            callTitle: call?.title,
            callDate: call?.started,
            callUrl: call?.url,
            speakerId: transcript.speakerId,
            topic: transcript.topic,
            matchCount: matchingSentences.length,
            matches: matchingSentences.map(s => ({
              text: s.text,
              startTime: s.start,
              // Include context (surrounding text)
              context: this.getContext(transcript.sentences, s.start, 50)
            }))
          });

          if (matches.length >= maxResults) {
            break;
          }
        }
      }
      
      if (matches.length >= maxResults) {
        break;
      }
    }

    return {
      searchText,
      matches,
      totalCalls: callsResponse.calls.length,
      searchedCalls: callIds.length,
      resultsLimited: matches.length >= maxResults
    };
  }

  private getContext(sentences: Array<{start: number; text: string}>, targetStart: number, contextWords: number): string {
    const targetIndex = sentences.findIndex(s => s.start === targetStart);
    if (targetIndex === -1) return '';

    let context = '';
    let wordCount = 0;
    
    // Add sentences before
    for (let i = targetIndex - 1; i >= 0 && wordCount < contextWords / 2; i--) {
      const words = sentences[i].text.split(' ');
      wordCount += words.length;
      context = sentences[i].text + ' ' + context;
    }
    
    // Add target sentence
    context += sentences[targetIndex].text;
    wordCount = 0;
    
    // Add sentences after
    for (let i = targetIndex + 1; i < sentences.length && wordCount < contextWords / 2; i++) {
      const words = sentences[i].text.split(' ');
      wordCount += words.length;
      context += ' ' + sentences[i].text;
    }
    
    return context.trim();
  }
}

// Default client for stdio mode (requires credentials)
let defaultGongClient: GongClient | null = null;
if (GONG_ACCESS_KEY && GONG_ACCESS_SECRET) {
  defaultGongClient = new GongClient(GONG_ACCESS_KEY, GONG_ACCESS_SECRET);
}

// Helper to get or create Gong client with optional bearer token
// IMPORTANT: This function creates a NEW client instance for each bearer token
// to ensure tokens are never cached or reused across requests.
function getGongClient(bearerToken?: string): GongClient {
  if (bearerToken) {
    // Always create a new client instance for bearer tokens
    // This ensures no token caching across requests
    return new GongClient(undefined, undefined, bearerToken);
  }
  if (defaultGongClient) {
    // Safe to reuse: environment credentials don't change per-request
    return defaultGongClient;
  }
  throw new Error('No Gong credentials available. Provide Authorization header or set GONG_ACCESS_KEY/GONG_ACCESS_SECRET');
}

// Tool definitions
const LIST_CALLS_TOOL: Tool = {
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
};

const RETRIEVE_TRANSCRIPTS_TOOL: Tool = {
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
};

const SEARCH_TRANSCRIPTS_TOOL: Tool = {
  name: "search_transcripts",
  description: "Search through call transcripts for specific text. Returns matching calls with context around the matches. Note: This searches locally after fetching transcripts, as Gong doesn't provide a native search API.",
  inputSchema: {
    type: "object",
    properties: {
      searchText: {
        type: "string",
        description: "Text to search for in transcripts (case-insensitive)"
      },
      fromDateTime: {
        type: "string",
        description: "Start date/time in ISO format (e.g. 2024-03-01T00:00:00Z)"
      },
      toDateTime: {
        type: "string",
        description: "End date/time in ISO format (e.g. 2024-03-31T23:59:59Z)"
      },
      maxResults: {
        type: "number",
        description: "Maximum number of matching calls to return (default: 50)"
      }
    },
    required: ["searchText"]
  }
};

// Server implementation
const server = new Server(
  {
    name: "example-servers/gong",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Type guards
function isGongListCallsArgs(args: unknown): args is GongListCallsArgs {
  return (
    typeof args === "object" &&
    args !== null &&
    (!("fromDateTime" in args) || typeof (args as GongListCallsArgs).fromDateTime === "string") &&
    (!("toDateTime" in args) || typeof (args as GongListCallsArgs).toDateTime === "string")
  );
}

function isGongRetrieveTranscriptsArgs(args: unknown): args is GongRetrieveTranscriptsArgs {
  return (
    typeof args === "object" &&
    args !== null &&
    "callIds" in args &&
    Array.isArray((args as GongRetrieveTranscriptsArgs).callIds) &&
    (args as GongRetrieveTranscriptsArgs).callIds.every(id => typeof id === "string")
  );
}

function isGongSearchTranscriptsArgs(args: unknown): args is GongSearchTranscriptsArgs {
  return (
    typeof args === "object" &&
    args !== null &&
    "searchText" in args &&
    typeof (args as GongSearchTranscriptsArgs).searchText === "string" &&
    (!("fromDateTime" in args) || typeof (args as GongSearchTranscriptsArgs).fromDateTime === "string") &&
    (!("toDateTime" in args) || typeof (args as GongSearchTranscriptsArgs).toDateTime === "string") &&
    (!("maxResults" in args) || typeof (args as GongSearchTranscriptsArgs).maxResults === "number")
  );
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [LIST_CALLS_TOOL, RETRIEVE_TRANSCRIPTS_TOOL, SEARCH_TRANSCRIPTS_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: unknown } }, extra) => {
  try {
    const { name, arguments: args } = request.params;

    if (!args) {
      throw new Error("No arguments provided");
    }

    // Extract bearer token from Authorization header if present
    let bearerToken: string | undefined;
    if (extra.requestInfo?.headers) {
      const authHeader = extra.requestInfo.headers['authorization'] || extra.requestInfo.headers['Authorization'];
      if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        bearerToken = authHeader.substring(7);
      }
    }

    // Get Gong client (creates new instance per request if bearer token provided)
    // This ensures tokens and clients are NEVER cached across requests
    const gongClient = getGongClient(bearerToken);

    switch (name) {
      case "list_calls": {
        if (!isGongListCallsArgs(args)) {
          throw new Error("Invalid arguments for list_calls");
        }
        const { fromDateTime, toDateTime } = args;
        const response = await gongClient.listCalls(fromDateTime, toDateTime);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify(response, null, 2)
          }],
          isError: false,
        };
      }

      case "retrieve_transcripts": {
        if (!isGongRetrieveTranscriptsArgs(args)) {
          throw new Error("Invalid arguments for retrieve_transcripts");
        }
        const { callIds } = args;
        const response = await gongClient.retrieveTranscripts(callIds);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify(response, null, 2)
          }],
          isError: false,
        };
      }

      case "search_transcripts": {
        if (!isGongSearchTranscriptsArgs(args)) {
          throw new Error("Invalid arguments for search_transcripts");
        }
        const { searchText, fromDateTime, toDateTime, maxResults } = args;
        const response = await gongClient.searchTranscripts(searchText, fromDateTime, toDateTime, maxResults);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify(response, null, 2)
          }],
          isError: false,
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

async function runServer() {
  const transport = process.env.MCP_TRANSPORT || 'stdio';
  
  if (transport === 'streamable-http') {
    // Streamable HTTP mode - run as HTTP server
    const port = parseInt(process.env.PORT || '3000', 10);
    // Heroku and other cloud platforms require binding to 0.0.0.0
    // Always use 0.0.0.0 for streamable-http unless HOST is explicitly set
    const host = process.env.HOST || '0.0.0.0';
    
    // Create Express app
    const app = express();
    app.use(express.json());
    
    // OAuth 2.0 Authorization Server Metadata (RFC 8414)
    // Documents Gong's OAuth endpoints per https://help.gong.io/docs/create-an-app-for-gong
    app.get('/.well-known/oauth-authorization-server', (req, res) => {
      res.type('application/json').json({
        issuer: 'https://app.gong.io',
        authorization_endpoint: 'https://app.gong.io/oauth2/authorize',
        token_endpoint: 'https://app.gong.io/oauth2/generate-customer-token',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        code_challenge_methods_supported: ['plain', 'S256'],
        scopes_supported: [
          'api:calls:read:basic',
          'api:calls:read:extensive',
          'api:calls:create',
          'api:users:read',
          'api:workspaces:read',
          'api:settings:read'
        ],
        documentation: 'https://help.gong.io/docs/create-an-app-for-gong',
        service_documentation: 'https://help.gong.io/docs/create-an-app-for-gong'
      });
    });

    // Health check endpoint
    app.get('/health', (req, res) => {
      res.json({ status: 'healthy', transport: 'streamable-http' });
    });
    
    // MCP endpoint - creates new transport for each request
    // This avoids session conflicts and handles timeouts better
    app.all('/mcp', async (req, res) => {
      try {
        // Create a new transport for this request (stateless mode)
        const httpTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // Stateless mode
          enableJsonResponse: true // Enable JSON-only responses (no SSE)
        });
        
        // Create a new server instance for this request
        const requestServer = new Server(
          { name: "example-servers/gong", version: "0.1.0" },
          { capabilities: { tools: {} } }
        );
        
        // Copy request handlers from main server to request server
        const mainServer = server as any;
        if (mainServer._requestHandlers) {
          (requestServer as any)._requestHandlers = new Map(mainServer._requestHandlers);
        }
        
        // Connect and handle request
        await requestServer.connect(httpTransport);
        await httpTransport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error',
            },
            id: null
          });
        }
      }
    });
    
    app.listen(port, host, () => {
      console.log(`Gong MCP server listening on http://${host}:${port}`);
      console.log(`MCP endpoint: http://${host}:${port}/mcp`);
      console.log(`Health check: http://${host}:${port}/health`);
    });
  } else {
    // Stdio mode - run as CLI process
    redirectConsole();
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
  }
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
}); 