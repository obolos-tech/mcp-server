/**
 * Obolos Marketplace API Client
 * Fetches API catalog from the Obolos marketplace backend
 */

import type {
  MarketplaceApi,
  MarketplaceListResponse,
  MarketplaceSearchResponse,
  CategoryResponse,
} from './types.js';

export class MarketplaceClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * List all marketplace APIs with optional category filter
   */
  async listApis(options?: {
    category?: string;
    page?: number;
    limit?: number;
  }): Promise<MarketplaceListResponse> {
    const params = new URLSearchParams();
    if (options?.category) params.set('category', options.category);
    if (options?.page) params.set('page', String(options.page));
    if (options?.limit) params.set('limit', String(options.limit));
    params.set('type', 'native');

    const url = `${this.baseUrl}/api/marketplace/apis?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Marketplace list failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  /**
   * Search APIs by query, category, and sort order
   */
  async searchApis(options: {
    query?: string;
    category?: string;
    sort?: 'popular' | 'newest' | 'price_asc' | 'price_desc';
    page?: number;
    limit?: number;
  }): Promise<MarketplaceSearchResponse> {
    const params = new URLSearchParams();
    if (options.query) params.set('q', options.query);
    if (options.category) params.set('category', options.category);
    if (options.sort) params.set('sort', options.sort);
    if (options.page) params.set('page', String(options.page));
    if (options.limit) params.set('limit', String(options.limit));
    params.set('type', 'native');

    const url = `${this.baseUrl}/api/marketplace/apis/search?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Marketplace search failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  /**
   * Get full details for a single API
   */
  async getApiDetails(id: string): Promise<MarketplaceApi> {
    const url = `${this.baseUrl}/api/marketplace/apis/${encodeURIComponent(id)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API detail fetch failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  /**
   * List all available categories
   */
  async getCategories(): Promise<CategoryResponse> {
    const url = `${this.baseUrl}/api/marketplace/categories`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Categories fetch failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  /**
   * Call an API via the Obolos proxy.
   * Handles the x402 payment flow: initial request → 402 → sign → retry.
   */
  async callApi(
    apiId: string,
    options: {
      method?: string;
      body?: Record<string, unknown>;
      queryParams?: Record<string, string>;
      signPayment: (paymentRequired: any) => Promise<Record<string, string>>;
    },
  ): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
    const method = (options.method || 'GET').toUpperCase();
    const proxyUrl = new URL(`${this.baseUrl}/api/proxy/${encodeURIComponent(apiId)}`);

    if (options.queryParams) {
      for (const [k, v] of Object.entries(options.queryParams)) {
        proxyUrl.searchParams.set(k, v);
      }
    }

    const fetchOptions: RequestInit = { method };
    if (method !== 'GET' && options.body) {
      fetchOptions.headers = { 'Content-Type': 'application/json' };
      fetchOptions.body = JSON.stringify(options.body);
    }

    // First request — expect 402
    let response = await fetch(proxyUrl.toString(), fetchOptions);

    if (response.status === 402) {
      // Parse payment requirements from body (v1 format) or header (v2)
      let paymentInfo: any;
      try {
        paymentInfo = await response.json();
      } catch {
        throw new Error('Got 402 but could not parse payment requirements');
      }

      // Ask caller to sign the payment
      const paymentHeaders = await options.signPayment(paymentInfo);

      // Retry with payment
      const paidFetchOptions: RequestInit = {
        ...fetchOptions,
        headers: {
          ...(fetchOptions.headers || {}),
          ...paymentHeaders,
        },
      };
      response = await fetch(proxyUrl.toString(), paidFetchOptions);
    }

    // Collect response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    // Parse response body
    const contentType = response.headers.get('content-type') || '';
    let body: unknown;
    if (contentType.includes('application/json')) {
      body = await response.json();
    } else if (contentType.includes('text/')) {
      body = await response.text();
    } else {
      // Binary — return base64
      const buffer = await response.arrayBuffer();
      body = {
        _binary: true,
        contentType,
        base64: Buffer.from(buffer).toString('base64'),
        size: buffer.byteLength,
      };
    }

    return { status: response.status, headers: responseHeaders, body };
  }
}
