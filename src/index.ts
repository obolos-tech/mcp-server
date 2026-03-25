#!/usr/bin/env node
/**
 * Obolos MCP Server
 *
 * Exposes the Obolos x402 API marketplace as MCP tools.
 * Any AI agent (Claude Code, Cursor, Windsurf, etc.) can discover,
 * browse, and pay for APIs through this server.
 *
 * Configuration (env vars):
 *   OBOLOS_API_URL     — Marketplace URL (default: https://obolos.tech)
 *   OBOLOS_PRIVATE_KEY — Wallet private key for x402 payments (optional)
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { MarketplaceClient } from './marketplace.js';
import { PaymentSigner } from './payment.js';
import { ACPClient } from './acp.js';
import { ANP_TYPES, getANPDomain, computeContentHash, usdToUsdc, hashListingIntent as hashListingStruct, hashBidIntent as hashBidStruct } from '@obolos_tech/anp-sdk';

// ─── ANP (Agent Negotiation Protocol) Helpers ───────────────────────────────

const ANP_SETTLEMENT_ADDRESS = '0xfEa362Bf569e97B20681289fB4D4a64CEBDFa792' as `0x${string}`;
const ANP_DOMAIN = getANPDomain(8453, ANP_SETTLEMENT_ADDRESS);

// Shared config with @obolos_tech/cli — written by `obolos setup`
function loadConfig(): Record<string, string> {
  try {
    const configFile = join(homedir(), '.obolos', 'config.json');
    if (existsSync(configFile)) {
      return JSON.parse(readFileSync(configFile, 'utf-8'));
    }
  } catch {}
  return {};
}

const config = loadConfig();
const OBOLOS_API_URL = process.env.OBOLOS_API_URL || config.api_url || 'https://obolos.tech';
const OBOLOS_PRIVATE_KEY = process.env.OBOLOS_PRIVATE_KEY || config.private_key || '';

const marketplace = new MarketplaceClient(OBOLOS_API_URL);
const signer = OBOLOS_PRIVATE_KEY ? new PaymentSigner(OBOLOS_PRIVATE_KEY) : null;
const acpClient = OBOLOS_PRIVATE_KEY ? new ACPClient(OBOLOS_PRIVATE_KEY) : null;

// ANP wallet client for EIP-712 signing (reuses the same private key)
const anpWalletClient = OBOLOS_PRIVATE_KEY
  ? (() => {
      const pk = OBOLOS_PRIVATE_KEY.startsWith('0x') ? OBOLOS_PRIVATE_KEY : `0x${OBOLOS_PRIVATE_KEY}`;
      const account = privateKeyToAccount(pk as `0x${string}`);
      return createWalletClient({ account, chain: base, transport: http() });
    })()
  : null;

const server = new McpServer({
  name: 'obolos',
  version: '0.1.0',
});

// ─── Tool: search_apis ──────────────────────────────────────────────────────

server.tool(
  'search_apis',
  'Search the Obolos x402 marketplace for pay-per-call APIs. ' +
    'Returns APIs that AI agents can call with automatic USDC micropayments. ' +
    'Use this to find data services, AI endpoints, blockchain tools, and more.',
  {
    query: z.string().optional().describe('Search query (e.g. "weather", "token price", "web scraping")'),
    category: z.string().optional().describe('Filter by category'),
    sort: z.enum(['popular', 'newest', 'price_asc', 'price_desc']).optional()
      .describe('Sort order. Default: popular'),
    limit: z.number().min(1).max(50).optional().describe('Max results (default 20)'),
  },
  async ({ query, category, sort, limit }) => {
    try {
      const result = await marketplace.searchApis({
        query,
        category,
        sort,
        limit: limit || 20,
      });

      const summary = result.apis.map((api) => ({
        id: api.id,
        name: api.name,
        description: api.description?.slice(0, 200),
        category: api.category,
        price: `$${api.price_per_call.toFixed(4)} USDC`,
        method: api.http_method,
        type: api.api_type,
        rating: api.average_rating ? `${api.average_rating.toFixed(1)}/5` : 'unrated',
        calls: api.total_calls,
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                total: result.pagination.total,
                showing: summary.length,
                apis: summary,
                tip: 'Use get_api_details with an API id to see full details including input fields. Use call_api to execute.',
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error searching APIs: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: list_categories ──────────────────────────────────────────────────

server.tool(
  'list_categories',
  'List all API categories available on the Obolos marketplace. ' +
    'Useful for browsing what types of APIs are available.',
  {},
  async () => {
    try {
      const result = await marketplace.getCategories();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                categories: result.categories,
                total_native_apis: result.nativeCount,
                total_external_apis: result.externalCount,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: get_api_details ──────────────────────────────────────────────────

server.tool(
  'get_api_details',
  'Get full details for a specific API including input fields, pricing, ' +
    'example request/response, and how to call it. Use an API id from search_apis.',
  {
    api_id: z.string().describe('The API id (e.g. "ext-a1b2c3d4" for external, or a UUID for native)'),
  },
  async ({ api_id }) => {
    try {
      const api = await marketplace.getApiDetails(api_id);

      const details: Record<string, unknown> = {
        id: api.id,
        name: api.name,
        description: api.description,
        category: api.category,
        price: `$${api.price_per_call.toFixed(4)} USDC per call`,
        method: api.http_method,
        type: api.api_type,
        rating: api.average_rating ? `${api.average_rating.toFixed(1)}/5 (${api.review_count} reviews)` : 'unrated',
        total_calls: api.total_calls,
        seller: api.seller_name,
      };

      if (api.input_schema) {
        details.input_fields = api.input_schema;
      }

      if (api.example_request) {
        try {
          details.example_request = JSON.parse(api.example_request);
        } catch {
          details.example_request = api.example_request;
        }
      }

      if (api.example_response) {
        try {
          details.example_response = JSON.parse(api.example_response);
        } catch {
          details.example_response = api.example_response;
        }
      }

      details.proxy_url = `${OBOLOS_API_URL}/api/proxy/${api.id}`;
      details.how_to_call = {
        tool: 'call_api',
        params: {
          api_id: api.id,
          method: api.http_method,
          body: api.input_schema?.fields
            ? Object.fromEntries(
                Object.entries(api.input_schema.fields).map(([k, v]) => [
                  k,
                  v.example ?? `<${v.type}>`,
                ]),
              )
            : undefined,
        },
        note: signer
          ? `Payment will be signed automatically with wallet ${signer.address}`
          : 'No wallet configured. Run `npx @obolos_tech/cli setup` or set OBOLOS_PRIVATE_KEY.',
        important: 'Always use the call_api tool or the proxy_url above. Never call the API slug directly — the full path /api/proxy/{id} is required.',
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(details, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: call_api ─────────────────────────────────────────────────────────

server.tool(
  'call_api',
  'Execute an API call on the Obolos marketplace with automatic x402 USDC payment. ' +
    'Requires OBOLOS_PRIVATE_KEY env var to be set. ' +
    'The payment is a micropayment (typically $0.001–$0.01 USDC per call).',
  {
    api_id: z.string().describe('The API id to call'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH']).optional().describe('HTTP method (default: GET)'),
    body: z.record(z.unknown()).optional().describe('Request body (for POST/PUT/PATCH)'),
    query_params: z.record(z.string()).optional().describe('Query parameters (for GET)'),
  },
  async ({ api_id, method, body, query_params }) => {
    if (!signer) {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              'No wallet configured. Set up a wallet using one of these methods:\n\n' +
              '1. Run: npx @obolos_tech/cli setup --generate\n' +
              '2. Or set OBOLOS_PRIVATE_KEY env var in your MCP server config.\n\n' +
              'The wallet needs USDC on Base to pay for API calls.',
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await marketplace.callApi(api_id, {
        method,
        body,
        queryParams: query_params,
        signPayment: async (paymentRequired) => {
          return signer.signPayment(paymentRequired);
        },
      });

      if (result.status >= 400) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error: true,
                  status: result.status,
                  body: result.body,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                status: result.status,
                data: result.body,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `API call failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: get_balance ──────────────────────────────────────────────────────

server.tool(
  'get_balance',
  'Check the USDC balance of the configured payment wallet on Base.',
  {},
  async () => {
    if (!signer) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No wallet configured. Run `npx @obolos_tech/cli setup` or set OBOLOS_PRIVATE_KEY.',
          },
        ],
        isError: true,
      };
    }

    try {
      const balance = await signer.getUsdcBalance();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                address: signer.address,
                usdc_balance: `${balance.formatted} USDC`,
                network: 'Base (Chain ID: 8453)',
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Balance check failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: create_job ──────────────────────────────────────────────────────

server.tool(
  'create_job',
  'Create a new ERC-8183 Agentic Commerce Protocol job on Obolos. ' +
    'Jobs allow escrowed USDC payments for work — client locks funds, provider does the work, ' +
    'evaluator approves/rejects. Use this for task-based agent commerce.',
  {
    title: z.string().describe('Short job title'),
    description: z.string().describe('Detailed description of what needs to be done'),
    evaluator_address: z.string().describe('Wallet address of the evaluator who will approve/reject. Use your own address for self-evaluation.'),
    provider_address: z.string().optional().describe('Wallet address of the provider. Leave empty for open jobs anyone can pick up.'),
    budget: z.string().optional().describe('Budget in USDC (e.g. "5.00")'),
    expired_at: z.string().optional().describe('Expiry as ISO date or relative (e.g. "2026-04-01T00:00:00Z" or "24h")'),
    hook_address: z.string().optional().describe('Optional hook contract address for custom logic'),
  },
  async ({ title, description, evaluator_address, provider_address, budget, expired_at, hook_address }) => {
    const walletAddress = signer?.address;
    if (!walletAddress) {
      return {
        content: [{ type: 'text' as const, text: 'No wallet configured. Run `npx @obolos_tech/cli setup` or set OBOLOS_PRIVATE_KEY.' }],
        isError: true,
      };
    }

    try {
      // Create job on-chain first if ACP client is available
      let chainJobId: string | null = null;
      let chainTxHash: string | null = null;

      if (acpClient) {
        // Parse expiry to unix timestamp (default: 7 days from now)
        let expiredAt: number;
        if (expired_at) {
          const d = new Date(expired_at);
          if (isNaN(d.getTime())) {
            // Try relative parsing (e.g. "24h", "7d")
            const match = expired_at.match(/^(\d+)\s*(h|d|m)$/i);
            if (match) {
              const num = parseInt(match[1], 10);
              const unit = match[2].toLowerCase();
              const ms = unit === 'h' ? num * 3600000 : unit === 'd' ? num * 86400000 : num * 60000;
              expiredAt = Math.floor((Date.now() + ms) / 1000);
            } else {
              expiredAt = Math.floor((Date.now() + 7 * 86400000) / 1000);
            }
          } else {
            expiredAt = Math.floor(d.getTime() / 1000);
          }
        } else {
          expiredAt = Math.floor((Date.now() + 7 * 86400000) / 1000);
        }

        const result = await acpClient.createJob({
          provider: provider_address || '0x0000000000000000000000000000000000000000',
          evaluator: evaluator_address,
          expiredAt,
          description: description || title,
          hook: hook_address || '0x0000000000000000000000000000000000000000',
        });

        chainJobId = result.jobId.toString();
        chainTxHash = result.txHash;
      }

      // Then create in backend database to keep in sync
      const resp = await fetch(`${OBOLOS_API_URL}/api/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wallet-address': walletAddress },
        body: JSON.stringify({
          title,
          description,
          evaluator_address,
          provider_address,
          budget,
          expired_at,
          hook_address,
          chain_job_id: chainJobId,
          chain_tx_hash: chainTxHash,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: 'Job created successfully',
            job: data,
            on_chain: chainJobId
              ? { chain_job_id: chainJobId, tx_hash: chainTxHash, contract: '0xaF3148696242F7Fb74893DC47690e37950807362' }
              : null,
            next_steps: data.provider_address
              ? 'Set a budget with setBudget, then fund the escrow with fund_job.'
              : 'Assign a provider, set a budget, then fund the escrow.',
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to create job: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: list_jobs ───────────────────────────────────────────────────────

server.tool(
  'list_jobs',
  'Browse ERC-8183 jobs on the Obolos marketplace. Filter by status, client, or provider address.',
  {
    status: z.enum(['open', 'funded', 'submitted', 'completed', 'rejected', 'expired']).optional()
      .describe('Filter by job status'),
    client: z.string().optional().describe('Filter by client wallet address'),
    provider: z.string().optional().describe('Filter by provider wallet address'),
    page: z.number().optional().describe('Page number (default: 1)'),
    limit: z.number().optional().describe('Results per page (default: 20)'),
  },
  async ({ status, client, provider, page, limit }) => {
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (client) params.set('client', client);
      if (provider) params.set('provider', provider);
      if (page) params.set('page', String(page));
      if (limit) params.set('limit', String(limit));

      const resp = await fetch(`${OBOLOS_API_URL}/api/jobs?${params}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      const summary = data.jobs.map((j: Record<string, unknown>) => ({
        id: j.id,
        title: j.title,
        status: j.status,
        budget: j.budget ? `${j.budget} USDC` : 'not set',
        client: j.client_address,
        provider: j.provider_address || 'open',
        created: j.created_at,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total: data.pagination.total,
            showing: summary.length,
            jobs: summary,
            tip: 'Use get_job with a job id for full details.',
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to list jobs: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: get_job ─────────────────────────────────────────────────────────

server.tool(
  'get_job',
  'Get full details for a specific ERC-8183 job including status, budget, addresses, deliverable, and available actions.',
  {
    id: z.string().describe('The job ID'),
  },
  async ({ id }) => {
    try {
      const resp = await fetch(`${OBOLOS_API_URL}/api/jobs/${id}`);
      const job = await resp.json();
      if (!resp.ok) throw new Error(job.error || `HTTP ${resp.status}`);

      const walletAddress = signer?.address?.toLowerCase();
      const actions: string[] = [];
      const s = job.status;
      const isClient = walletAddress === job.client_address?.toLowerCase();
      const isProvider = walletAddress === job.provider_address?.toLowerCase();
      const isEvaluator = walletAddress === job.evaluator_address?.toLowerCase();

      if (s === 'open' && isClient) {
        if (!job.provider_address) actions.push('set provider');
        actions.push('set budget', 'fund', 'reject');
      }
      if (s === 'funded' && isProvider) actions.push('submit work');
      if (s === 'submitted' && isEvaluator) actions.push('complete', 'reject');
      if ((s === 'funded' || s === 'submitted') && job.expired_at && new Date(job.expired_at) < new Date()) {
        actions.push('claim refund (expired)');
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...job,
            your_role: isClient ? 'client' : isProvider ? 'provider' : isEvaluator ? 'evaluator' : 'none',
            available_actions: actions.length > 0 ? actions : ['none — you have no actions for this job in its current state'],
            state_machine: `Open ${s === 'open' ? '◀' : '→'} Funded ${s === 'funded' ? '◀' : '→'} Submitted ${s === 'submitted' ? '◀' : '→'} Completed/Rejected`,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get job: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: fund_job ────────────────────────────────────────────────────────

server.tool(
  'fund_job',
  'Fund a job\'s USDC escrow. This locks the budget amount in the ACP smart contract. ' +
    'Only the client can fund. Provider and budget must already be set.',
  {
    id: z.string().describe('The job ID to fund'),
    expected_budget: z.string().describe('Expected budget amount in USDC (front-run protection)'),
  },
  async ({ id, expected_budget }) => {
    const walletAddress = signer?.address;
    if (!walletAddress) {
      return {
        content: [{ type: 'text' as const, text: 'No wallet configured.' }],
        isError: true,
      };
    }

    try {
      // Fetch the job to get the chain_job_id
      const jobResp = await fetch(`${OBOLOS_API_URL}/api/jobs/${id}`);
      const jobData = await jobResp.json();
      if (!jobResp.ok) throw new Error(jobData.error || `HTTP ${jobResp.status}`);
      const job = jobData.job || jobData;
      const chainJobId = job.chain_job_id;

      let txHash: string | null = null;

      if (acpClient && chainJobId) {
        // Fund on-chain: approve USDC + call fund()
        txHash = await acpClient.fundJob(BigInt(chainJobId), expected_budget);
      }

      // Update backend
      const resp = await fetch(`${OBOLOS_API_URL}/api/jobs/${id}/fund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wallet-address': walletAddress },
        body: JSON.stringify({
          expected_budget,
          tx_hash: txHash || 'pending-onchain',
          chain_job_id: chainJobId || null,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Job funded with ${expected_budget} USDC escrow`,
            job: data,
            on_chain: txHash
              ? { tx_hash: txHash, chain_job_id: chainJobId, contract: '0xaF3148696242F7Fb74893DC47690e37950807362' }
              : { note: 'No chain_job_id found — backend-only funding recorded.' },
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to fund job: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: submit_job ──────────────────────────────────────────────────────

server.tool(
  'submit_job',
  'Submit work for a funded ERC-8183 job. Only the assigned provider can submit. ' +
    'The deliverable should be a hash, IPFS CID, or URL referencing the completed work.',
  {
    id: z.string().describe('The job ID'),
    deliverable: z.string().describe('Hash, IPFS CID, or URL of the completed work'),
  },
  async ({ id, deliverable }) => {
    const walletAddress = signer?.address;
    if (!walletAddress) {
      return {
        content: [{ type: 'text' as const, text: 'No wallet configured.' }],
        isError: true,
      };
    }

    try {
      // Fetch job to get chain_job_id
      const jobResp = await fetch(`${OBOLOS_API_URL}/api/jobs/${id}`);
      const jobData = await jobResp.json();
      if (!jobResp.ok) throw new Error(jobData.error || `HTTP ${jobResp.status}`);
      const job = jobData.job || jobData;
      const chainJobId = job.chain_job_id;

      let txHash: string | null = null;

      if (acpClient && chainJobId) {
        txHash = await acpClient.submitJob(BigInt(chainJobId), deliverable);
      }

      // Update backend
      const resp = await fetch(`${OBOLOS_API_URL}/api/jobs/${id}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wallet-address': walletAddress },
        body: JSON.stringify({ deliverable, tx_hash: txHash }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: 'Work submitted successfully. Awaiting evaluator review.',
            job: data,
            on_chain: txHash
              ? { tx_hash: txHash, chain_job_id: chainJobId, contract: '0xaF3148696242F7Fb74893DC47690e37950807362' }
              : null,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to submit work: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: evaluate_job ────────────────────────────────────────────────────

server.tool(
  'evaluate_job',
  'Evaluate a submitted ERC-8183 job — either complete (approve + release payment) or reject (refund client). ' +
    'Only the designated evaluator can call this after the provider has submitted work.',
  {
    id: z.string().describe('The job ID'),
    action: z.enum(['complete', 'reject']).describe('"complete" to approve and release payment, "reject" to refund client'),
    reason: z.string().optional().describe('Optional reason/attestation for the evaluation decision'),
  },
  async ({ id, action, reason }) => {
    const walletAddress = signer?.address;
    if (!walletAddress) {
      return {
        content: [{ type: 'text' as const, text: 'No wallet configured.' }],
        isError: true,
      };
    }

    try {
      // Fetch job to get chain_job_id
      const jobResp = await fetch(`${OBOLOS_API_URL}/api/jobs/${id}`);
      const jobData = await jobResp.json();
      if (!jobResp.ok) throw new Error(jobData.error || `HTTP ${jobResp.status}`);
      const job = jobData.job || jobData;
      const chainJobId = job.chain_job_id;

      let txHash: string | null = null;

      if (acpClient && chainJobId) {
        if (action === 'complete') {
          txHash = await acpClient.completeJob(BigInt(chainJobId), reason);
        } else {
          txHash = await acpClient.rejectJob(BigInt(chainJobId), reason);
        }
      }

      // Update backend
      const resp = await fetch(`${OBOLOS_API_URL}/api/jobs/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wallet-address': walletAddress },
        body: JSON.stringify({ reason, tx_hash: txHash }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      const msg = action === 'complete'
        ? 'Job completed! Payment released to provider.'
        : 'Job rejected. Escrow refunded to client.';

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: msg,
            job: data,
            on_chain: txHash
              ? { tx_hash: txHash, chain_job_id: chainJobId, contract: '0xaF3148696242F7Fb74893DC47690e37950807362' }
              : null,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to evaluate job: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: create_listing ─────────────────────────────────────────────────

server.tool(
  'create_listing',
  'Create a job listing for agents to bid on. Other agents can browse and submit competing bids. ' +
    'When you accept a bid, an ACP job is automatically created with the negotiated terms.',
  {
    title: z.string().describe('Short listing title describing what you need done'),
    description: z.string().describe('Detailed description of the work required'),
    min_budget: z.string().optional().describe('Minimum budget in USDC (e.g. "1.00")'),
    max_budget: z.string().optional().describe('Maximum budget in USDC (e.g. "10.00")'),
    deadline: z.string().optional().describe('Bidding deadline as ISO date or relative (e.g. "7d", "24h")'),
    job_duration: z.number().optional().describe('Expected hours for provider to complete the work'),
    preferred_evaluator: z.string().optional().describe('Preferred evaluator wallet address (0x...)'),
    hook_address: z.string().optional().describe('Optional hook contract address for custom logic'),
  },
  async ({ title, description, min_budget, max_budget, deadline, job_duration, preferred_evaluator, hook_address }) => {
    const walletAddress = signer?.address;
    if (!walletAddress) {
      return {
        content: [{ type: 'text' as const, text: 'No wallet configured. Run `npx @obolos_tech/cli setup` or set OBOLOS_PRIVATE_KEY.' }],
        isError: true,
      };
    }

    try {
      const payload: Record<string, unknown> = { title, description };
      if (min_budget) payload.min_budget = min_budget;
      if (max_budget) payload.max_budget = max_budget;
      if (deadline) payload.deadline = deadline;
      if (job_duration) payload.job_duration = job_duration;
      if (preferred_evaluator) payload.preferred_evaluator = preferred_evaluator;
      if (hook_address) payload.hook_address = hook_address;

      const resp = await fetch(`${OBOLOS_API_URL}/api/listings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wallet-address': walletAddress },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: 'Listing created successfully',
            listing: data,
            next_steps: 'Share this listing ID with potential providers. They can submit bids using submit_bid. Use list_listings or get_listing to monitor bids.',
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to create listing: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: list_listings ──────────────────────────────────────────────────

server.tool(
  'list_listings',
  'Browse open job listings on the Obolos marketplace. Agents can find work opportunities and submit bids.',
  {
    status: z.enum(['open', 'negotiating', 'accepted', 'cancelled']).optional()
      .describe('Filter by listing status'),
    client: z.string().optional().describe('Filter by client wallet address'),
    page: z.number().optional().describe('Page number (default: 1)'),
    limit: z.number().optional().describe('Results per page (default: 20)'),
  },
  async ({ status, client, page, limit }) => {
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (client) params.set('client', client);
      if (page) params.set('page', String(page));
      if (limit) params.set('limit', String(limit));

      const resp = await fetch(`${OBOLOS_API_URL}/api/listings?${params}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      const listings = data.listings || data.data || [];
      const summary = listings.map((l: Record<string, unknown>) => ({
        id: l.id,
        title: l.title,
        status: l.status,
        budget_range: l.min_budget || l.max_budget
          ? `${l.min_budget ? `$${l.min_budget}` : '?'} – ${l.max_budget ? `$${l.max_budget}` : '?'} USDC`
          : 'not set',
        bids: (l as any).bid_count ?? (l as any).bids?.length ?? 0,
        deadline: l.deadline || 'none',
        client: l.client_address,
        created: l.created_at,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total: data.pagination?.total || listings.length,
            showing: summary.length,
            listings: summary,
            tip: 'Use get_listing with a listing id to see full details and all bids. Use submit_bid to bid on a listing.',
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to list listings: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: get_listing ────────────────────────────────────────────────────

server.tool(
  'get_listing',
  'Get full details for a specific listing including all bids from providers. Use this to review bids before accepting one.',
  {
    id: z.string().describe('The listing ID'),
  },
  async ({ id }) => {
    try {
      const resp = await fetch(`${OBOLOS_API_URL}/api/listings/${id}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      const listing = data.listing || data;
      const bids = listing.bids || [];

      const formattedBids = bids.map((b: Record<string, unknown>) => ({
        bid_id: b.id,
        provider: b.provider_address,
        price: b.price ? `$${b.price} USDC` : 'not specified',
        delivery_time: b.delivery_time ? `${b.delivery_time}h` : 'not specified',
        message: b.message || '',
        submitted: b.created_at,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            id: listing.id,
            title: listing.title,
            description: listing.description,
            status: listing.status,
            client: listing.client_address,
            budget_range: {
              min: listing.min_budget ? `$${listing.min_budget} USDC` : 'not set',
              max: listing.max_budget ? `$${listing.max_budget} USDC` : 'not set',
            },
            deadline: listing.deadline || 'none',
            job_duration: listing.job_duration ? `${listing.job_duration}h` : 'not set',
            preferred_evaluator: listing.preferred_evaluator || 'none',
            bids: formattedBids,
            bid_count: formattedBids.length,
            created: listing.created_at,
            tip: listing.status === 'open' && formattedBids.length > 0
              ? 'Use accept_bid with the listing_id and bid_id to accept a bid and auto-create an ACP job.'
              : listing.status === 'open'
                ? 'No bids yet. Share this listing with providers.'
                : undefined,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get listing: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: submit_bid ─────────────────────────────────────────────────────

server.tool(
  'submit_bid',
  'Submit a bid on a job listing. Propose your price and delivery time to the client. ' +
    'If accepted, an ACP job will be created automatically with you as the provider.',
  {
    listing_id: z.string().describe('The listing ID to bid on'),
    price: z.string().describe('Your proposed price in USDC (e.g. "5.00")'),
    delivery_time: z.number().optional().describe('Estimated delivery time in hours'),
    message: z.string().optional().describe('Pitch to the client explaining why you should be chosen'),
    proposal_hash: z.string().optional().describe('Optional hash of a detailed proposal document'),
  },
  async ({ listing_id, price, delivery_time, message, proposal_hash }) => {
    const walletAddress = signer?.address;
    if (!walletAddress) {
      return {
        content: [{ type: 'text' as const, text: 'No wallet configured. Run `npx @obolos_tech/cli setup` or set OBOLOS_PRIVATE_KEY.' }],
        isError: true,
      };
    }

    try {
      const payload: Record<string, unknown> = { price };
      if (delivery_time) payload.delivery_time = delivery_time;
      if (message) payload.message = message;
      if (proposal_hash) payload.proposal_hash = proposal_hash;

      const resp = await fetch(`${OBOLOS_API_URL}/api/listings/${listing_id}/bid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wallet-address': walletAddress },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: 'Bid submitted successfully',
            bid: data,
            next_steps: 'The client will review your bid. If accepted, an ACP job will be created with the negotiated terms.',
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to submit bid: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Tool: accept_bid ─────────────────────────────────────────────────────

server.tool(
  'accept_bid',
  'Accept a bid on your listing. This creates an ACP job automatically with the negotiated price, ' +
    'provider, and evaluator. Only the listing creator can accept bids.',
  {
    listing_id: z.string().describe('The listing ID'),
    bid_id: z.string().describe('The bid ID to accept'),
  },
  async ({ listing_id, bid_id }) => {
    const walletAddress = signer?.address;
    if (!walletAddress) {
      return {
        content: [{ type: 'text' as const, text: 'No wallet configured. Run `npx @obolos_tech/cli setup` or set OBOLOS_PRIVATE_KEY.' }],
        isError: true,
      };
    }

    try {
      // If ACP client available, create on-chain job from the negotiated terms
      let chainJobId: string | null = null;
      let chainTxHash: string | null = null;

      if (acpClient) {
        // Fetch listing + bid details to get provider, evaluator, etc.
        const listingResp = await fetch(`${OBOLOS_API_URL}/api/listings/${listing_id}`);
        const listingData = await listingResp.json();
        if (!listingResp.ok) throw new Error(listingData.error || `HTTP ${listingResp.status}`);

        const listing = listingData.listing || listingData;
        const bids = listing.bids || [];
        const acceptedBid = bids.find((b: Record<string, unknown>) => b.id === bid_id);

        if (acceptedBid) {
          const providerAddress = (acceptedBid.provider_address as string) || '0x0000000000000000000000000000000000000000';
          const evaluatorAddress = (listing.preferred_evaluator as string) || walletAddress;

          // Default expiry: job_duration hours from now, or 7 days
          const durationHours = (acceptedBid.delivery_time as number) || (listing.job_duration as number) || 168;
          const expiredAt = Math.floor((Date.now() + durationHours * 3600000) / 1000);

          const description = `${listing.title}: ${listing.description || ''}`.slice(0, 500);

          const result = await acpClient.createJob({
            provider: providerAddress,
            evaluator: evaluatorAddress,
            expiredAt,
            description,
            hook: (listing.hook_address as string) || '0x0000000000000000000000000000000000000000',
          });

          chainJobId = result.jobId.toString();
          chainTxHash = result.txHash;
        }
      }

      // Accept on backend (will also create backend job record)
      const payload: Record<string, unknown> = { bid_id };
      if (chainJobId) payload.acp_job_id = chainJobId;
      if (chainTxHash) payload.chain_tx_hash = chainTxHash;

      const resp = await fetch(`${OBOLOS_API_URL}/api/listings/${listing_id}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wallet-address': walletAddress },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: 'Bid accepted! ACP job created from negotiated terms.',
            listing: data,
            on_chain: chainJobId
              ? { chain_job_id: chainJobId, tx_hash: chainTxHash, contract: '0xaF3148696242F7Fb74893DC47690e37950807362' }
              : null,
            next_steps: 'The ACP job has been created. Fund the escrow with fund_job, then the provider can start working.',
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to accept bid: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── ANP Tools (Agent Negotiation Protocol — EIP-712 signed documents) ──────

server.tool(
  'anp_publish_listing',
  'Sign and publish an ANP listing via EIP-712. Creates a cryptographically signed, ' +
    'content-addressed listing document. Other agents can bid on it using anp_publish_bid.',
  {
    title: z.string().describe('Short listing title'),
    description: z.string().describe('Detailed description of the work required'),
    min_budget: z.number().describe('Minimum budget in USD (e.g. 1.00)'),
    max_budget: z.number().describe('Maximum budget in USD (e.g. 10.00)'),
    deadline_hours: z.number().describe('Hours until bidding deadline'),
    job_duration_hours: z.number().describe('Expected hours for provider to complete the work'),
    evaluator: z.string().optional().describe('Preferred evaluator wallet address (0x...)'),
  },
  async ({ title, description, min_budget, max_budget, deadline_hours, job_duration_hours, evaluator }) => {
    if (!anpWalletClient) {
      return {
        content: [{ type: 'text' as const, text: 'No wallet configured. Set OBOLOS_PRIVATE_KEY or run `npx @obolos_tech/cli setup`.' }],
        isError: true,
      };
    }

    try {
      const minBudget = usdToUsdc(min_budget);
      const maxBudget = usdToUsdc(max_budget);
      const contentHash = await computeContentHash({ title, description });
      const nonce = Math.floor(Math.random() * 2 ** 32);
      const deadline = Math.floor(Date.now() / 1000) + deadline_hours * 3600;
      const jobDuration = job_duration_hours * 3600;
      const preferredEvaluator = (evaluator || '0x0000000000000000000000000000000000000000') as `0x${string}`;

      const message = {
        contentHash,
        minBudget: BigInt(minBudget),
        maxBudget: BigInt(maxBudget),
        deadline: BigInt(deadline),
        jobDuration: BigInt(jobDuration),
        preferredEvaluator,
        nonce: BigInt(nonce),
      };

      const signature = await anpWalletClient.signTypedData({
        domain: ANP_DOMAIN,
        types: ANP_TYPES,
        primaryType: 'ListingIntent',
        message,
      });

      const signerAddress = anpWalletClient.account!.address.toLowerCase();

      const document = {
        protocol: 'anp/v1',
        type: 'listing',
        data: {
          title,
          description,
          minBudget,
          maxBudget,
          deadline,
          jobDuration,
          preferredEvaluator,
          nonce,
        },
        signer: signerAddress,
        signature,
        timestamp: Date.now(),
      };

      const resp = await fetch(`${OBOLOS_API_URL}/api/anp/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(document),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: 'ANP listing published successfully',
            cid: data.cid,
            signer: signerAddress,
            budget_range: `$${min_budget} – $${max_budget} USD`,
            deadline: new Date(deadline * 1000).toISOString(),
            next_steps: 'Share the CID with potential providers. They can bid using anp_publish_bid.',
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to publish ANP listing: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'anp_publish_bid',
  'Sign and publish an ANP bid on an existing listing. Creates a cryptographically signed bid ' +
    'document that references the listing by CID and struct hash.',
  {
    listing_cid: z.string().describe('CID of the listing to bid on'),
    price: z.number().describe('Your proposed price in USD (e.g. 5.00)'),
    delivery_hours: z.number().describe('Estimated delivery time in hours'),
    message: z.string().optional().describe('Short message to the client'),
  },
  async ({ listing_cid, price, delivery_hours, message: bidMessage }) => {
    if (!anpWalletClient) {
      return {
        content: [{ type: 'text' as const, text: 'No wallet configured. Set OBOLOS_PRIVATE_KEY or run `npx @obolos_tech/cli setup`.' }],
        isError: true,
      };
    }

    try {
      // Fetch the listing document
      const listingResp = await fetch(`${OBOLOS_API_URL}/api/anp/objects/${listing_cid}`);
      const listingDoc = await listingResp.json();
      if (!listingResp.ok) throw new Error(listingDoc.error || `HTTP ${listingResp.status}`);

      const ld = listingDoc.data || listingDoc;

      // Compute the listing struct hash
      const listingContentHash = await computeContentHash({ title: ld.title, description: ld.description });
      const listingHash = hashListingStruct({
        contentHash: listingContentHash,
        minBudget: BigInt(ld.minBudget),
        maxBudget: BigInt(ld.maxBudget),
        deadline: BigInt(ld.deadline),
        jobDuration: BigInt(ld.jobDuration),
        preferredEvaluator: (ld.preferredEvaluator || '0x0000000000000000000000000000000000000000') as `0x${string}`,
        nonce: BigInt(ld.nonce),
      });

      const priceUsdc = usdToUsdc(price);
      const deliveryTime = delivery_hours * 3600;
      const contentHash = await computeContentHash({ message: bidMessage || '', proposalCid: '' });
      const nonce = Math.floor(Math.random() * 2 ** 32);

      const bidMsg = {
        listingHash,
        contentHash,
        price: BigInt(priceUsdc),
        deliveryTime: BigInt(deliveryTime),
        nonce: BigInt(nonce),
      };

      const signature = await anpWalletClient.signTypedData({
        domain: ANP_DOMAIN,
        types: ANP_TYPES,
        primaryType: 'BidIntent',
        message: bidMsg,
      });

      const signerAddress = anpWalletClient.account!.address.toLowerCase();

      const document = {
        protocol: 'anp/v1',
        type: 'bid',
        data: {
          listingCid: listing_cid,
          listingHash,
          price: priceUsdc,
          deliveryTime,
          message: bidMessage || '',
          nonce,
        },
        signer: signerAddress,
        signature,
        timestamp: Date.now(),
      };

      const resp = await fetch(`${OBOLOS_API_URL}/api/anp/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(document),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: 'ANP bid published successfully',
            cid: data.cid,
            listing_cid,
            price: `$${price} USD`,
            delivery: `${delivery_hours}h`,
            signer: signerAddress,
            next_steps: 'The listing creator can accept your bid using anp_accept_bid.',
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to publish ANP bid: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'anp_accept_bid',
  'Sign and publish an acceptance of an ANP bid. Creates a cryptographically signed acceptance ' +
    'document that references both the listing and bid by CID and struct hash.',
  {
    listing_cid: z.string().describe('CID of the listing'),
    bid_cid: z.string().describe('CID of the bid to accept'),
  },
  async ({ listing_cid, bid_cid }) => {
    if (!anpWalletClient) {
      return {
        content: [{ type: 'text' as const, text: 'No wallet configured. Set OBOLOS_PRIVATE_KEY or run `npx @obolos_tech/cli setup`.' }],
        isError: true,
      };
    }

    try {
      // Fetch listing and bid documents
      const [listingResp, bidResp] = await Promise.all([
        fetch(`${OBOLOS_API_URL}/api/anp/objects/${listing_cid}`),
        fetch(`${OBOLOS_API_URL}/api/anp/objects/${bid_cid}`),
      ]);
      const listingDoc = await listingResp.json();
      const bidDoc = await bidResp.json();
      if (!listingResp.ok) throw new Error(listingDoc.error || `HTTP ${listingResp.status}`);
      if (!bidResp.ok) throw new Error(bidDoc.error || `HTTP ${bidResp.status}`);

      const ld = listingDoc.data || listingDoc;
      const bd = bidDoc.data || bidDoc;

      // Compute listing struct hash
      const listingContentHash = await computeContentHash({ title: ld.title, description: ld.description });
      const listingHash = hashListingStruct({
        contentHash: listingContentHash,
        minBudget: BigInt(ld.minBudget),
        maxBudget: BigInt(ld.maxBudget),
        deadline: BigInt(ld.deadline),
        jobDuration: BigInt(ld.jobDuration),
        preferredEvaluator: (ld.preferredEvaluator || '0x0000000000000000000000000000000000000000') as `0x${string}`,
        nonce: BigInt(ld.nonce),
      });

      // Compute bid struct hash
      const bidContentHash = await computeContentHash({ message: bd.message || '', proposalCid: bd.proposalCid || '' });
      const bidHash = hashBidStruct({
        listingHash: bd.listingHash as `0x${string}`,
        contentHash: bidContentHash,
        price: BigInt(bd.price),
        deliveryTime: BigInt(bd.deliveryTime),
        nonce: BigInt(bd.nonce),
      });

      const nonce = Math.floor(Math.random() * 2 ** 32);

      const acceptMsg = {
        listingHash,
        bidHash,
        nonce: BigInt(nonce),
      };

      const signature = await anpWalletClient.signTypedData({
        domain: ANP_DOMAIN,
        types: ANP_TYPES,
        primaryType: 'AcceptIntent',
        message: acceptMsg,
      });

      const signerAddress = anpWalletClient.account!.address.toLowerCase();

      const document = {
        protocol: 'anp/v1',
        type: 'acceptance',
        data: {
          listingCid: listing_cid,
          bidCid: bid_cid,
          listingHash,
          bidHash,
          nonce,
        },
        signer: signerAddress,
        signature,
        timestamp: Date.now(),
      };

      const resp = await fetch(`${OBOLOS_API_URL}/api/anp/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(document),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: 'ANP bid accepted! Acceptance document published.',
            cid: data.cid,
            listing_cid,
            bid_cid,
            signer: signerAddress,
            next_steps: 'The three signed documents (listing, bid, acceptance) can now be submitted to the settlement contract on-chain.',
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to publish ANP acceptance: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'anp_list_listings',
  'Browse ANP listings — cryptographically signed job postings from the Agent Negotiation Protocol.',
  {
    status: z.enum(['open', 'negotiating', 'accepted']).optional()
      .describe('Filter by listing status'),
    page: z.number().optional().describe('Page number (default: 1)'),
  },
  async ({ status, page }) => {
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (page) params.set('page', String(page));

      const resp = await fetch(`${OBOLOS_API_URL}/api/anp/listings?${params}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      const listings = data.listings || data.data || [];
      const summary = listings.map((l: Record<string, unknown>) => {
        const ld = (l as any).data || l;
        return {
          cid: l.cid || (l as any).id,
          title: ld.title,
          status: l.status || 'open',
          budget_range: ld.minBudget && ld.maxBudget
            ? `$${(Number(ld.minBudget) / 1_000_000).toFixed(2)} – $${(Number(ld.maxBudget) / 1_000_000).toFixed(2)} USDC`
            : 'not set',
          deadline: ld.deadline ? new Date(Number(ld.deadline) * 1000).toISOString() : 'none',
          bids: (l as any).bid_count ?? 0,
          signer: l.signer || ld.signer,
        };
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total: data.pagination?.total || listings.length,
            showing: summary.length,
            listings: summary,
            tip: 'Use anp_get_listing with a CID for full details. Use anp_publish_bid to bid on a listing.',
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to list ANP listings: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'anp_get_listing',
  'Get full details for an ANP listing including all bids. Shows the signed document data, ' +
    'budget range, deadline, and all bid documents from providers.',
  {
    cid: z.string().describe('The listing CID (content identifier)'),
  },
  async ({ cid }) => {
    try {
      const resp = await fetch(`${OBOLOS_API_URL}/api/anp/listings/${cid}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      const listing = data.listing || data;
      const ld = listing.data || listing;
      const bids = listing.bids || [];

      const formattedBids = bids.map((b: Record<string, unknown>) => {
        const bd = (b as any).data || b;
        return {
          cid: b.cid || (b as any).id,
          provider: b.signer || bd.signer,
          price: bd.price ? `$${(Number(bd.price) / 1_000_000).toFixed(2)} USDC` : 'not specified',
          delivery_time: bd.deliveryTime ? `${Math.round(Number(bd.deliveryTime) / 3600)}h` : 'not specified',
          message: bd.message || '',
          timestamp: b.timestamp ? new Date(Number(b.timestamp)).toISOString() : '',
        };
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            cid: listing.cid || cid,
            title: ld.title,
            description: ld.description,
            status: listing.status || 'open',
            signer: listing.signer,
            budget_range: {
              min: ld.minBudget ? `$${(Number(ld.minBudget) / 1_000_000).toFixed(2)} USDC` : 'not set',
              max: ld.maxBudget ? `$${(Number(ld.maxBudget) / 1_000_000).toFixed(2)} USDC` : 'not set',
            },
            deadline: ld.deadline ? new Date(Number(ld.deadline) * 1000).toISOString() : 'none',
            job_duration: ld.jobDuration ? `${Math.round(Number(ld.jobDuration) / 3600)}h` : 'not set',
            preferred_evaluator: ld.preferredEvaluator || 'none',
            signature: listing.signature,
            bids: formattedBids,
            bid_count: formattedBids.length,
            tip: formattedBids.length > 0
              ? 'Use anp_accept_bid with the listing CID and bid CID to accept a bid.'
              : 'No bids yet. Share the CID with potential providers.',
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get ANP listing: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'anp_verify',
  'Verify the integrity and signature of an ANP document by its CID. ' +
    'Checks content hash, EIP-712 signature recovery, and cross-references.',
  {
    cid: z.string().describe('The document CID to verify'),
  },
  async ({ cid }) => {
    try {
      const resp = await fetch(`${OBOLOS_API_URL}/api/anp/verify/${cid}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            cid,
            verification: data,
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to verify ANP document: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─── Resources ──────────────────────────────────────────────────────────────

server.resource(
  'marketplace-info',
  'obolos://marketplace/info',
  async () => ({
    contents: [
      {
        uri: 'obolos://marketplace/info',
        mimeType: 'application/json',
        text: JSON.stringify(
          {
            name: 'Obolos x402 Marketplace',
            url: OBOLOS_API_URL,
            description:
              'Pay-per-call API marketplace powered by x402 micropayments. ' +
              'Browse and call hundreds of APIs with automatic USDC payments on Base. ' +
              'Only 1% platform fee — 99% goes directly to API creators.',
            wallet: signer
              ? { address: signer.address, configured: true }
              : { configured: false, note: 'Run `npx @obolos_tech/cli setup` or set OBOLOS_PRIVATE_KEY' },
            documentation: 'https://obolos.tech/app/marketplace',
          },
          null,
          2,
        ),
      },
    ],
  }),
);

// ─── Start ──────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[obolos-mcp] Connected to ${OBOLOS_API_URL}`);
  if (signer) {
    console.error(`[obolos-mcp] Wallet: ${signer.address}`);
    console.error(`[obolos-mcp] ACP contract: ${acpClient ? '0xaF3148696242F7Fb74893DC47690e37950807362 (Base)' : 'disabled'}`);
  } else {
    console.error('[obolos-mcp] No wallet configured. Run `npx @obolos_tech/cli setup` or set OBOLOS_PRIVATE_KEY.');
  }
}

main().catch((err) => {
  console.error('[obolos-mcp] Fatal:', err);
  process.exit(1);
});
