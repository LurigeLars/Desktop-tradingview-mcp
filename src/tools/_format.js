/**
 * Shared MCP response formatting helper.
 * All tool files use this instead of manually constructing MCP responses.
 */
import { rememberToolResult } from '../server/tool-usage.js';

export function jsonResult(obj, isError = false) {
  const result = {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    ...(isError && { isError: true }),
  };
  return rememberToolResult(result,obj,isError);
}
