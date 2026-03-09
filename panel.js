const state = {
  entries: [],
  selectedId: null,
  filterText: "",
  onlyErrors: false,
};

const requestList = document.getElementById("request-list");
const detailTitle = document.getElementById("detail-title");
const detailContent = document.getElementById("detail-content");
const statusLabel = document.getElementById("status");
const filterInput = document.getElementById("filter");
const onlyErrorsInput = document.getElementById("only-errors");
const clearButton = document.getElementById("clear");
const itemTemplate = document.getElementById("request-item-template");

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseJsonIfString(value) {
  if (typeof value !== "string") {
    return value;
  }

  const parsed = safeJsonParse(value);
  return parsed === null ? value : parsed;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractWrappedCallFromVariables(variables) {
  const parsedVariables = parseJsonIfString(variables);
  if (!isPlainObject(parsedVariables)) {
    return null;
  }

  const input = parseJsonIfString(parsedVariables.input);
  if (!isPlainObject(input)) {
    return null;
  }

  const payload = parseJsonIfString(input.payload);
  if (!isPlainObject(payload)) {
    return null;
  }

  const call = parseJsonIfString(payload.call);
  if (!call) {
    return null;
  }

  if (!isPlainObject(call)) {
    return call;
  }

  const normalizedCall = { ...call };
  normalizedCall.headers = parseJsonIfString(normalizedCall.headers);
  normalizedCall.body = parseJsonIfString(normalizedCall.body);
  return normalizedCall;
}

function normalizeInvokeExtensionResponse(response) {
  const parsedResponse = parseJsonIfString(response);
  if (!parsedResponse || typeof parsedResponse !== "object" || Array.isArray(parsedResponse)) {
    return parsedResponse;
  }

  const normalizedResponse = { ...parsedResponse };
  normalizedResponse.body = parseJsonIfString(normalizedResponse.body);

  if (normalizedResponse.body && typeof normalizedResponse.body === "object" && !Array.isArray(normalizedResponse.body)) {
    const body = { ...normalizedResponse.body };

    if (body.error && typeof body.error === "object" && !Array.isArray(body.error)) {
      const error = { ...body.error };
      error.headers = parseJsonIfString(error.headers);
      error.body = parseJsonIfString(error.body);
      body.error = error;
    }

    normalizedResponse.body = body;
  }

  return normalizedResponse;
}

function extractInvokeExtensionResponseFromData(data) {
  const parsedData = parseJsonIfString(data);
  if (!parsedData || typeof parsedData !== "object" || Array.isArray(parsedData)) {
    return null;
  }

  const invokeExtension = parseJsonIfString(parsedData.invokeExtension);
  if (!invokeExtension || typeof invokeExtension !== "object" || Array.isArray(invokeExtension)) {
    return null;
  }

  if (!("response" in invokeExtension)) {
    return null;
  }

  return normalizeInvokeExtensionResponse(invokeExtension.response);
}

function pretty(value) {
  if (value === undefined || value === null || value === "") {
    return "(empty)";
  }

  if (typeof value === "string") {
    const parsed = safeJsonParse(value);
    if (parsed !== null) {
      return JSON.stringify(parsed, null, 2);
    }

    return value;
  }

  return JSON.stringify(value, null, 2);
}

function headersToObject(headers = []) {
  const obj = {};
  for (const header of headers) {
    if (!header || !header.name) {
      continue;
    }
    obj[header.name] = header.value;
  }
  return obj;
}

function parseGetGraphQL(url) {
  try {
    const parsed = new URL(url);
    const query = parsed.searchParams.get("query");
    const operationName = parsed.searchParams.get("operationName");
    const variablesRaw = parsed.searchParams.get("variables");
    const extensionsRaw = parsed.searchParams.get("extensions");
    const variables = safeJsonParse(variablesRaw || "") ?? variablesRaw ?? null;
    const extensions = safeJsonParse(extensionsRaw || "") ?? extensionsRaw ?? null;

    if (!query && !operationName && !variablesRaw && !extensionsRaw) {
      return null;
    }

    return {
      kind: "single",
      operationName: operationName || "",
      query: query || "",
      variables,
      extensions,
      wrappedCall: extractWrappedCallFromVariables(variables),
      raw: {
        query,
        operationName,
        variables: variablesRaw,
        extensions: extensionsRaw,
      },
    };
  } catch {
    return null;
  }
}

function parsePostGraphQL(postDataText) {
  if (!postDataText) {
    return null;
  }

  const json = safeJsonParse(postDataText);
  if (json === null) {
    // Accept direct GraphQL query payload (non-JSON)
    if (postDataText.trim().startsWith("query") || postDataText.trim().startsWith("mutation")) {
      return {
        kind: "single",
        operationName: "",
        query: postDataText.trim(),
        variables: null,
        extensions: null,
        raw: postDataText,
      };
    }
    return null;
  }

  if (Array.isArray(json)) {
    const operations = json
      .map((op, index) => {
        if (!op || typeof op !== "object") {
          return null;
        }

        const hasGraphqlFields = op.query || op.operationName || op.variables || op.extensions;
        if (!hasGraphqlFields) {
          return null;
        }

        const variables = op.variables ?? null;
        return {
          index,
          operationName: op.operationName || "",
          query: op.query || "",
          variables,
          extensions: op.extensions ?? null,
          persistedQueryHash: op.extensions?.persistedQuery?.sha256Hash || null,
          wrappedCall: extractWrappedCallFromVariables(variables),
        };
      })
      .filter(Boolean);

    if (operations.length === 0) {
      return null;
    }

    const wrappedCalls = operations
      .filter((op) => op.wrappedCall !== null && op.wrappedCall !== undefined)
      .map((op) => ({
        index: op.index,
        operationName: op.operationName || "",
        call: op.wrappedCall,
      }));

    return {
      kind: "batch",
      operations,
      wrappedCalls,
      raw: json,
    };
  }

  const hasGraphqlFields = json.query || json.operationName || json.variables || json.extensions;
  if (!hasGraphqlFields) {
    return null;
  }

  const variables = json.variables ?? null;
  return {
    kind: "single",
    operationName: json.operationName || "",
    query: json.query || "",
    variables,
    extensions: json.extensions ?? null,
    persistedQueryHash: json.extensions?.persistedQuery?.sha256Hash || null,
    wrappedCall: extractWrappedCallFromVariables(variables),
    raw: json,
  };
}

function parseGraphQLRequest(request) {
  const postDataText = request.request.postData?.text || "";
  const parsedPost = parsePostGraphQL(postDataText);
  const parsedGet = parseGetGraphQL(request.request.url);

  if (parsedPost) {
    return parsedPost;
  }

  if (parsedGet) {
    return parsedGet;
  }

  const urlLooksLikeGraphql = request.request.url.toLowerCase().includes("graphql");
  if (!urlLooksLikeGraphql) {
    return null;
  }

  return {
    kind: "unknown",
    raw: postDataText || "(no request body)",
  };
}

function hasExtractedCallInRequest(requestGraphql) {
  if (!requestGraphql || typeof requestGraphql !== "object") {
    return false;
  }

  if (requestGraphql.kind === "single") {
    return requestGraphql.wrappedCall !== null && requestGraphql.wrappedCall !== undefined;
  }

  if (requestGraphql.kind === "batch") {
    return Array.isArray(requestGraphql.wrappedCalls) && requestGraphql.wrappedCalls.length > 0;
  }

  return false;
}

function parseGraphQLResponse(text) {
  if (!text) {
    return null;
  }

  const json = safeJsonParse(text);
  if (json === null) {
    return null;
  }

  if (Array.isArray(json)) {
    const unwrapped = json.map((item) => {
      if (!item || typeof item !== "object") {
        return item;
      }
      return {
        data: item.data ?? null,
        errors: item.errors ?? null,
        extensions: item.extensions ?? null,
      };
    });

    const invokeExtensionResponses = json
      .map((item, index) => {
        if (!item || typeof item !== "object") {
          return null;
        }

        const extracted = extractInvokeExtensionResponseFromData(item.data);
        if (extracted === null || extracted === undefined) {
          return null;
        }

        return {
          index,
          response: extracted,
        };
      })
      .filter(Boolean);

    return {
      kind: "batch",
      unwrapped,
      invokeExtensionResponses,
      hasErrors: unwrapped.some((item) => Array.isArray(item?.errors) && item.errors.length > 0),
      raw: json,
    };
  }

  if (typeof json !== "object") {
    return null;
  }

  const isGraphQL = "data" in json || "errors" in json || "extensions" in json;
  if (!isGraphQL) {
    return null;
  }

  const data = json.data ?? null;
  return {
    kind: "single",
    data,
    errors: json.errors ?? null,
    extensions: json.extensions ?? null,
    invokeExtensionResponse: extractInvokeExtensionResponseFromData(data),
    hasErrors: Array.isArray(json.errors) && json.errors.length > 0,
    raw: json,
  };
}

function statusClass(status) {
  if (status >= 500 || status === 0) {
    return "error";
  }

  if (status >= 400) {
    return "warn";
  }

  return "ok";
}

function abbreviateUrl(raw) {
  try {
    const url = new URL(raw);
    return `${url.host}${url.pathname}`;
  } catch {
    return raw;
  }
}

function humanDuration(ms) {
  if (typeof ms !== "number" || Number.isNaN(ms)) {
    return "-";
  }

  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }

  return `${(ms / 1000).toFixed(2)} s`;
}

function getGraphqlOperationLabel(entry) {
  if (entry.requestGraphql?.kind === "single") {
    return entry.requestGraphql.operationName || "(anonymous operation)";
  }

  if (entry.requestGraphql?.kind === "batch") {
    const names = entry.requestGraphql.operations
      .map((op) => op.operationName || "anonymous")
      .slice(0, 3)
      .join(", ");
    return `Batch: ${names}`;
  }

  return "(graphql endpoint)";
}

function getWrappedCallMethod(call) {
  if (!call || typeof call !== "object" || Array.isArray(call)) {
    return "";
  }

  return typeof call.method === "string" ? call.method.toUpperCase() : "";
}

function getWrappedCallUrl(call) {
  if (!call || typeof call !== "object" || Array.isArray(call)) {
    return "";
  }

  const candidates = [call.url, call.path, call.endpoint, call.uri];
  const first = candidates.find((candidate) => typeof candidate === "string" && candidate.trim() !== "");
  return first || "";
}

function hasKeys(value) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function addParameterIfMeaningful(target, key, value) {
  if (value === undefined || value === null) {
    return;
  }

  if (isPlainObject(value) && Object.keys(value).length === 0) {
    return;
  }

  target[key] = value;
}

function parseQueryParamsFromUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    return null;
  }

  try {
    const parsed =
      rawUrl.startsWith("http://") || rawUrl.startsWith("https://")
        ? new URL(rawUrl)
        : new URL(rawUrl, "https://wrapped-request.local");

    const queryParams = {};
    for (const [key, value] of parsed.searchParams.entries()) {
      if (key in queryParams) {
        if (Array.isArray(queryParams[key])) {
          queryParams[key].push(value);
        } else {
          queryParams[key] = [queryParams[key], value];
        }
      } else {
        queryParams[key] = value;
      }
    }

    return hasKeys(queryParams) ? queryParams : null;
  } catch {
    return null;
  }
}

function extractRequestParametersFromCall(call) {
  const normalizedCall = parseJsonIfString(call);
  if (!isPlainObject(normalizedCall)) {
    return null;
  }

  const urlParams = parseQueryParamsFromUrl(getWrappedCallUrl(normalizedCall));
  const params = parseJsonIfString(normalizedCall.params);
  const query = parseJsonIfString(normalizedCall.query);
  const queryParams = parseJsonIfString(normalizedCall.queryParams);
  const queryParameters = parseJsonIfString(normalizedCall.queryParameters);
  const pathParams = parseJsonIfString(normalizedCall.pathParams);
  const pathParameters = parseJsonIfString(normalizedCall.pathParameters);
  const requestParameters = parseJsonIfString(normalizedCall.requestParameters);

  const extracted = {};

  addParameterIfMeaningful(extracted, "urlQuery", urlParams);
  addParameterIfMeaningful(extracted, "params", params);
  addParameterIfMeaningful(extracted, "query", query);
  addParameterIfMeaningful(extracted, "queryParams", queryParams);
  addParameterIfMeaningful(extracted, "queryParameters", queryParameters);
  addParameterIfMeaningful(extracted, "pathParams", pathParams);
  addParameterIfMeaningful(extracted, "pathParameters", pathParameters);
  addParameterIfMeaningful(extracted, "requestParameters", requestParameters);

  return hasKeys(extracted) ? extracted : null;
}

function extractInvokeExtensionResponseHeaders(invokeResponse) {
  if (!isPlainObject(invokeResponse)) {
    return null;
  }

  const root = parseJsonIfString(invokeResponse.body);
  if (!isPlainObject(root)) {
    return null;
  }

  const payload = parseJsonIfString(root.payload);
  if (isPlainObject(payload) && "headers" in payload) {
    return parseJsonIfString(payload.headers);
  }

  if (isPlainObject(root.error) && "headers" in root.error) {
    return parseJsonIfString(root.error.headers);
  }

  if ("headers" in root) {
    return parseJsonIfString(root.headers);
  }

  return null;
}

function extractInvokeExtensionResponsePayload(invokeResponse) {
  if (!isPlainObject(invokeResponse)) {
    return null;
  }

  const root = parseJsonIfString(invokeResponse.body ?? null);
  if (!isPlainObject(root)) {
    return root;
  }

  const payload = parseJsonIfString(root.payload);
  if (isPlainObject(payload) && "body" in payload) {
    return parseJsonIfString(payload.body);
  }

  if (isPlainObject(root.error) && "body" in root.error) {
    return parseJsonIfString(root.error.body);
  }

  if ("body" in root) {
    return parseJsonIfString(root.body);
  }

  return null;
}

function toNumericStatus(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }

  return null;
}

function extractStatusCodeFromPayload(payload) {
  const parsedPayload = parseJsonIfString(payload);
  if (!isPlainObject(parsedPayload)) {
    return null;
  }

  const directKeys = ["status", "statusCode", "httpStatus", "httpStatusCode"];
  for (const key of directKeys) {
    const numeric = toNumericStatus(parsedPayload[key]);
    if (numeric !== null) {
      return numeric;
    }
  }

  const error = parseJsonIfString(parsedPayload.error);
  if (isPlainObject(error)) {
    const errorKeys = ["status", "statusCode", "httpStatus", "httpStatusCode"];
    for (const key of errorKeys) {
      const numeric = toNumericStatus(error[key]);
      if (numeric !== null) {
        return numeric;
      }
    }

    const errorBody = parseJsonIfString(error.body);
    if (isPlainObject(errorBody)) {
      const errorBodyKeys = ["status", "statusCode", "httpStatus", "httpStatusCode", "code"];
      for (const key of errorBodyKeys) {
        const numeric = toNumericStatus(errorBody[key]);
        if (numeric !== null) {
          return numeric;
        }
      }
    }
  }

  const fallbackCode = toNumericStatus(parsedPayload.code);
  if (fallbackCode !== null) {
    return fallbackCode;
  }

  return null;
}

function extractInvokeExtensionStatusCode(invokeResponse) {
  if (!isPlainObject(invokeResponse)) {
    return null;
  }

  const root = parseJsonIfString(invokeResponse.body ?? null);
  if (!isPlainObject(root)) {
    return null;
  }

  const payload = parseJsonIfString(root.payload);
  const payloadStatus = extractStatusCodeFromPayload(payload);
  if (payloadStatus !== null) {
    return payloadStatus;
  }

  return extractStatusCodeFromPayload(root);
}

function toWrappedHttpItem(call, invokeResponse, index = null, operationName = "") {
  const normalizedCall = parseJsonIfString(call);
  const requestHeaders =
    normalizedCall && typeof normalizedCall === "object" && !Array.isArray(normalizedCall)
      ? parseJsonIfString(normalizedCall.headers ?? null)
      : null;
  const requestPayload =
    normalizedCall && typeof normalizedCall === "object" && !Array.isArray(normalizedCall)
      ? parseJsonIfString(normalizedCall.body ?? null)
      : normalizedCall;
  const responsePayload = extractInvokeExtensionResponsePayload(invokeResponse);

  const method = getWrappedCallMethod(normalizedCall);
  const url = getWrappedCallUrl(normalizedCall);

  return {
    index,
    operationName,
    method: method || "(unknown)",
    url: url || "(unknown)",
    statusCode: extractInvokeExtensionStatusCode(invokeResponse) ?? "(unknown)",
    requestParameters: extractRequestParametersFromCall(normalizedCall),
    requestHeaders,
    request: requestPayload,
    responseHeaders: extractInvokeExtensionResponseHeaders(invokeResponse),
    response: responsePayload,
    invokeResponse: invokeResponse ?? null,
  };
}

function getWrappedHttpItems(entry) {
  const wrappedCall = getExtractedWrappedCall(entry);
  if (!wrappedCall) {
    return [];
  }

  const invokeResponse = getExtractedInvokeExtensionResponse(entry);

  if (Array.isArray(wrappedCall)) {
    const responseByIndex = new Map();
    if (Array.isArray(invokeResponse)) {
      for (const item of invokeResponse) {
        if (item && typeof item === "object") {
          responseByIndex.set(item.index, item.response ?? null);
        }
      }
    }

    return wrappedCall.map((item, listIndex) =>
      toWrappedHttpItem(
        item.call,
        responseByIndex.get(item.index),
        item.index ?? listIndex,
        item.operationName || "",
      ),
    );
  }

  return [toWrappedHttpItem(wrappedCall, Array.isArray(invokeResponse) ? null : invokeResponse)];
}

function getDisplayOperation(entry) {
  const wrappedItems = getWrappedHttpItems(entry);
  if (wrappedItems.length > 0) {
    const primaryItem = getPrimaryWrappedHttpItem(entry) ?? wrappedItems[0];
    const url = primaryItem.url !== "(unknown)" ? primaryItem.url : "";
    const label = url.trim() || "Call";
    if (wrappedItems.length === 1) {
      return label;
    }
    return `${label} (+${wrappedItems.length - 1})`;
  }

  return getGraphqlOperationLabel(entry);
}

function getExtractedWrappedCall(entry) {
  if (entry.requestGraphql?.kind === "single") {
    return entry.requestGraphql.wrappedCall ?? null;
  }

  if (entry.requestGraphql?.kind === "batch") {
    if (!Array.isArray(entry.requestGraphql.wrappedCalls) || entry.requestGraphql.wrappedCalls.length === 0) {
      return null;
    }
    return entry.requestGraphql.wrappedCalls;
  }

  return null;
}

function getWrappedCallSummary(entry) {
  const wrappedItems = getWrappedHttpItems(entry);
  if (wrappedItems.length === 0) {
    return "none";
  }

  if (wrappedItems.length > 1) {
    const first = wrappedItems[0];
    const label =
      `${first.method !== "(unknown)" ? first.method : ""} ${first.url !== "(unknown)" ? first.url : ""}`.trim() ||
      "Call";
    return `${label} (+${wrappedItems.length - 1})`;
  }

  const [first] = wrappedItems;
  return (
    `${first.method !== "(unknown)" ? first.method : ""} ${first.url !== "(unknown)" ? first.url : ""}`.trim() ||
    "Call"
  );
}

function getWrappedCallSearchText(entry) {
  const wrappedItems = getWrappedHttpItems(entry);
  if (wrappedItems.length === 0) {
    return "";
  }

  return wrappedItems
    .map((item) => `${item.operationName} ${item.method} ${item.url} ${pretty(item.requestParameters)}`)
    .join(" ");
}

function getExtractedInvokeExtensionResponse(entry) {
  if (entry.responseGraphql?.kind === "single") {
    return entry.responseGraphql.invokeExtensionResponse ?? null;
  }

  if (entry.responseGraphql?.kind === "batch") {
    if (
      !Array.isArray(entry.responseGraphql.invokeExtensionResponses) ||
      entry.responseGraphql.invokeExtensionResponses.length === 0
    ) {
      return null;
    }
    return entry.responseGraphql.invokeExtensionResponses;
  }

  return null;
}

function getInvokeExtensionInnerStatus(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return null;
  }

  return extractInvokeExtensionStatusCode(response);
}

function getInvokeExtensionResponseSummary(entry) {
  const extracted = getExtractedInvokeExtensionResponse(entry);
  if (!extracted) {
    return "none";
  }

  if (Array.isArray(extracted)) {
    return `${extracted.length} extracted (batch)`;
  }

  if (typeof extracted !== "object") {
    return "extracted";
  }

  const status = getInvokeExtensionInnerStatus(extracted);
  if (status !== null) {
    return `innerStatus=${status}`;
  }

  return "extracted";
}

function extractMessageFromAnyBody(value) {
  const parsed = parseJsonIfString(value);
  if (!isPlainObject(parsed)) {
    return "";
  }

  if (typeof parsed.message === "string" && parsed.message.trim() !== "") {
    return parsed.message;
  }

  return "";
}

function extractInvokeExtensionErrorMessage(response) {
  if (!isPlainObject(response)) {
    return "";
  }

  const root = parseJsonIfString(response.body);
  if (!isPlainObject(root)) {
    return "";
  }

  const payload = parseJsonIfString(root.payload);
  if (isPlainObject(payload)) {
    const payloadBodyMessage = extractMessageFromAnyBody(payload.body);
    if (payloadBodyMessage) {
      return payloadBodyMessage;
    }

    const payloadError = parseJsonIfString(payload.error);
    if (isPlainObject(payloadError)) {
      const payloadErrorBodyMessage = extractMessageFromAnyBody(payloadError.body);
      if (payloadErrorBodyMessage) {
        return payloadErrorBodyMessage;
      }

      if (typeof payloadError.message === "string" && payloadError.message.trim() !== "") {
        return payloadError.message;
      }
    }

    if (typeof payload.message === "string" && payload.message.trim() !== "") {
      return payload.message;
    }
  }

  const rootError = parseJsonIfString(root.error);
  if (isPlainObject(rootError)) {
    const rootErrorBodyMessage = extractMessageFromAnyBody(rootError.body);
    if (rootErrorBodyMessage) {
      return rootErrorBodyMessage;
    }

    if (typeof rootError.message === "string" && rootError.message.trim() !== "") {
      return rootError.message;
    }
  }

  const rootBodyMessage = extractMessageFromAnyBody(root.body);
  if (rootBodyMessage) {
    return rootBodyMessage;
  }

  if (typeof root.message === "string" && root.message.trim() !== "") {
    return root.message;
  }

  return "";
}

function getInvokeExtensionSearchText(entry) {
  const extracted = getExtractedInvokeExtensionResponse(entry);
  if (!extracted) {
    return "";
  }

  if (Array.isArray(extracted)) {
    return extracted
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }

        const response = item.response;
        const innerStatus = getInvokeExtensionInnerStatus(response);
        const errorMessage = extractInvokeExtensionErrorMessage(response);
        return `${innerStatus ?? ""} ${errorMessage}`;
      })
      .join(" ");
  }

  if (typeof extracted !== "object") {
    return String(extracted);
  }

  const innerStatus = getInvokeExtensionInnerStatus(extracted);
  const errorMessage = extractInvokeExtensionErrorMessage(extracted);

  return `${innerStatus ?? ""} ${errorMessage}`;
}

function getSearchText(entry) {
  return [
    entry.method,
    entry.url,
    getDisplayOperation(entry),
    getPrimaryHttpStatus(entry),
    entry.status,
    entry.requestGraphql?.kind,
    getWrappedCallSearchText(entry),
    getInvokeExtensionSearchText(entry),
  ]
    .join(" ")
    .toLowerCase();
}

function filterEntries(entries) {
  return entries.filter((entry) => {
    if (state.onlyErrors) {
      const primaryStatus = getPrimaryHttpStatus(entry);
      const hasHttpError = primaryStatus >= 400 || primaryStatus === 0;
      const hasGraphqlError = !!entry.responseGraphql?.hasErrors;
      if (!hasHttpError && !hasGraphqlError) {
        return false;
      }
    }

    if (!state.filterText) {
      return true;
    }

    return getSearchText(entry).includes(state.filterText);
  });
}

function setSelected(id) {
  state.selectedId = id;
  render();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function section(title, content, asTable = false) {
  return `
    <div class="section">
      <h3>${escapeHtml(title)}</h3>
      <${asTable ? "div" : "pre"} class="${asTable ? "table" : ""}">${content}</${asTable ? "div" : "pre"}>
    </div>
  `;
}

function summaryRowsToHtml(rows, options = {}) {
  const { autoKeyWidth = false } = options;
  const tableClass = autoKeyWidth ? "kv-table kv-table-auto" : "kv-table kv-table-fixed";
  const body = rows
    .map(
      ([key, value]) =>
        `<tr class="summary-row"><td class="summary-key">${escapeHtml(key)}</td><td class="summary-value">${escapeHtml(pretty(value))}</td></tr>`,
    )
    .join("");

  return `<table class="${tableClass}"><tbody>${body}</tbody></table>`;
}

function flattenKeyValueRows(value, prefix = "", rows = []) {
  if (value === undefined) {
    return rows;
  }

  if (value === null || typeof value !== "object") {
    rows.push([prefix || "(value)", value]);
    return rows;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      rows.push([prefix || "(value)", []]);
      return rows;
    }

    value.forEach((item, index) => {
      const nextPrefix = prefix ? `${prefix}[${index}]` : `[${index}]`;
      flattenKeyValueRows(item, nextPrefix, rows);
    });
    return rows;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    rows.push([prefix || "(value)", {}]);
    return rows;
  }

  entries.forEach(([key, nestedValue]) => {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    flattenKeyValueRows(nestedValue, nextPrefix, rows);
  });

  return rows;
}

function requestParametersRows(requestParameters) {
  if (requestParameters === null || requestParameters === undefined) {
    return [];
  }

  return flattenKeyValueRows(requestParameters).map(([key, value]) => {
    if (typeof key !== "string") {
      return [key, value];
    }

    let normalizedKey = key;
    if (normalizedKey.startsWith("urlQuery.")) {
      normalizedKey = normalizedKey.slice("urlQuery.".length);
    } else if (normalizedKey.startsWith("urlQuery[")) {
      normalizedKey = normalizedKey.slice("urlQuery".length);
    }

    return [normalizedKey, value];
  });
}

function normalizeHeaderValue(value) {
  const parsed = parseJsonIfString(value);

  if (Array.isArray(parsed)) {
    return parsed.map((item) => String(item)).join(", ");
  }

  if (parsed === undefined || parsed === null || parsed === "") {
    return "(empty)";
  }

  if (typeof parsed === "object") {
    return parsed;
  }

  return String(parsed);
}

function headerRows(headers) {
  const parsedHeaders = parseJsonIfString(headers);
  if (!parsedHeaders || typeof parsedHeaders !== "object" || Array.isArray(parsedHeaders)) {
    return [];
  }

  return Object.entries(parsedHeaders)
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
    .map(([key, value]) => [key, normalizeHeaderValue(value)]);
}

function collapsedSection(title, content, open = false) {
  return `
    <details class="collapse-section"${open ? " open" : ""}>
      <summary>${escapeHtml(title)}</summary>
      <div class="collapse-content">${content}</div>
    </details>
  `;
}

function collapsibleBodySection(title, value, open = true) {
  return `
    <details class="collapse-section body-section"${open ? " open" : ""}>
      <summary>${escapeHtml(title)}</summary>
      <div class="collapse-content">
        <pre>${escapeHtml(pretty(value))}</pre>
      </div>
    </details>
  `;
}

function renderWrappedHttpSections(entry) {
  const wrappedItems = getWrappedHttpItems(entry);
  const items = wrappedItems.length > 0 ? wrappedItems : [toWrappedHttpItem(null, null)];

  return items
    .map((item, index) => {
      const suffix = items.length > 1 ? ` #${index + 1}` : "";
      const summary = summaryRowsToHtml([
        ["Method", item.method],
        ["URL", item.url],
        ["Status Code", item.statusCode],
      ]);
      const parameterRows = requestParametersRows(item.requestParameters);
      const requestHeaderRows = headerRows(item.requestHeaders);
      const responseHeaderRows = headerRows(item.responseHeaders);

      return [
        section(`Call${suffix} Summary`, summary, true),
        section(
          `Call${suffix} Request Parameters`,
          parameterRows.length > 0
            ? summaryRowsToHtml(parameterRows, { autoKeyWidth: true })
            : summaryRowsToHtml([["(none)", "(empty)"]], { autoKeyWidth: true }),
          true,
        ),
        section(
          `Call${suffix} Request Headers`,
          requestHeaderRows.length > 0
            ? summaryRowsToHtml(requestHeaderRows, { autoKeyWidth: true })
            : summaryRowsToHtml([["(none)", "(empty)"]], { autoKeyWidth: true }),
          true,
        ),
        collapsibleBodySection(`Call${suffix} Request Body`, item.request, true),
        section(
          `Call${suffix} Response Headers`,
          responseHeaderRows.length > 0
            ? summaryRowsToHtml(responseHeaderRows, { autoKeyWidth: true })
            : summaryRowsToHtml([["(none)", "(empty)"]], { autoKeyWidth: true }),
          true,
        ),
        collapsibleBodySection(`Call${suffix} Response Body`, item.response, true),
      ].join("");
    })
    .join("");
}

function getListMethod(entry) {
  const primaryItem = getPrimaryWrappedHttpItem(entry);
  if (primaryItem) {
    const method = primaryItem.method;
    if (method && method !== "(unknown)") {
      return method;
    }
  }

  return entry.method;
}

function getPrimaryWrappedHttpItem(entry) {
  const wrappedItems = getWrappedHttpItems(entry);
  if (wrappedItems.length === 0) {
    return null;
  }

  const withStatus = wrappedItems.find((item) => toNumericStatus(item.statusCode) !== null);
  if (withStatus) {
    return withStatus;
  }

  return wrappedItems[0];
}

function getPrimaryHttpStatus(entry) {
  const primaryItem = getPrimaryWrappedHttpItem(entry);
  if (primaryItem) {
    const wrappedStatus = toNumericStatus(primaryItem.statusCode);
    if (wrappedStatus !== null) {
      return wrappedStatus;
    }
  }

  return entry.status;
}

function getListUrl(entry) {
  const primaryItem = getPrimaryWrappedHttpItem(entry);
  if (primaryItem) {
    const wrappedUrl = primaryItem.url;
    if (wrappedUrl && wrappedUrl !== "(unknown)") {
      return wrappedUrl;
    }
  }

  return abbreviateUrl(entry.url);
}

function renderDetails(entry) {
  const primaryStatus = getPrimaryHttpStatus(entry);
  detailTitle.textContent = `${primaryStatus} ${getListMethod(entry)} ${getDisplayOperation(entry)}`;

  const summary = [
    ["URL", entry.url],
    ["Method", getListMethod(entry)],
    ["Status", primaryStatus],
    ["GraphQL Status", `${entry.status} ${entry.statusText || ""}`.trim()],
    ["Duration", humanDuration(entry.durationMs)],
    ["Started", entry.startedAt],
    ["GraphQL Request", entry.requestGraphql?.kind || "unknown"],
    ["GraphQL Response", entry.responseGraphql?.kind || "unknown"],
    ["Call", getWrappedCallSummary(entry)],
    ["InvokeExtension Response", getInvokeExtensionResponseSummary(entry)],
  ];

  const legacyDetails = [
    section("Summary", summaryRowsToHtml(summary), true),
    section("Request Headers", escapeHtml(pretty(entry.requestHeaders))),
    section("Response Headers", escapeHtml(pretty(entry.responseHeaders))),
    section("Request Body", escapeHtml(pretty(entry.requestBodyRaw))),
    section("Parsed GraphQL Request", escapeHtml(pretty(entry.requestGraphql))),
    section(
      "Extracted Call (variables.input.payload.call)",
      escapeHtml(pretty(getExtractedWrappedCall(entry))),
    ),
    section("Response Body", escapeHtml(pretty(entry.responseBodyRaw))),
    section(
      "Extracted InvokeExtension Response (/data/invokeExtension/response)",
      escapeHtml(pretty(getExtractedInvokeExtensionResponse(entry))),
    ),
    section("Parsed GraphQL Response", escapeHtml(pretty(entry.responseGraphql))),
  ].join("");

  const parts = [
    renderWrappedHttpSections(entry),
    collapsedSection("GraphQL / Raw Details", legacyDetails, false),
  ];

  detailContent.classList.remove("empty");
  detailContent.innerHTML = parts.join("");
}

function renderList(entries) {
  requestList.innerHTML = "";

  for (const entry of entries) {
    const clone = itemTemplate.content.firstElementChild.cloneNode(true);

    const statusEl = clone.querySelector(".status");
    const methodEl = clone.querySelector(".method");
    const operationEl = clone.querySelector(".operation");
    const urlEl = clone.querySelector(".url");
    const durationEl = clone.querySelector(".duration");

    const listStatus = getPrimaryHttpStatus(entry);
    statusEl.textContent = String(listStatus);
    statusEl.classList.add(statusClass(listStatus));
    methodEl.textContent = getListMethod(entry);
    operationEl.textContent = getDisplayOperation(entry);
    urlEl.textContent = getListUrl(entry);
    durationEl.textContent = humanDuration(entry.durationMs);

    if (entry.id === state.selectedId) {
      clone.classList.add("active");
    }

    const activate = () => setSelected(entry.id);
    clone.addEventListener("click", activate);
    clone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });

    requestList.appendChild(clone);
  }
}

function render() {
  const visibleEntries = filterEntries(state.entries);

  renderList(visibleEntries);

  if (visibleEntries.length === 0) {
    detailTitle.textContent = "No request selected";
    detailContent.classList.add("empty");
    detailContent.textContent = "No matching GraphQL requests.";
    return;
  }

  const selected = visibleEntries.find((entry) => entry.id === state.selectedId) ?? visibleEntries[0];
  if (selected.id !== state.selectedId) {
    state.selectedId = selected.id;
    renderList(visibleEntries);
  }

  renderDetails(selected);
}

function addEntry(entry) {
  state.entries.unshift(entry);
  statusLabel.textContent = `Captured ${state.entries.length} GraphQL request${state.entries.length === 1 ? "" : "s"}.`;
  render();
}

function handleFinishedRequest(request) {
  const requestGraphql = parseGraphQLRequest(request);
  if (!requestGraphql || !hasExtractedCallInRequest(requestGraphql)) {
    return;
  }

  request.getContent((content, encoding) => {
    const responseGraphql = parseGraphQLResponse(content);

    const entry = {
      id: crypto.randomUUID(),
      method: request.request.method,
      url: request.request.url,
      status: request.response.status,
      statusText: request.response.statusText,
      durationMs: request.time,
      startedAt: request.startedDateTime,
      requestHeaders: headersToObject(request.request.headers),
      responseHeaders: headersToObject(request.response.headers),
      requestBodyRaw: request.request.postData?.text ?? "",
      requestGraphql,
      responseBodyRaw: content || "",
      responseEncoding: encoding || "",
      responseGraphql,
    };

    addEntry(entry);
  });
}

filterInput.addEventListener("input", (event) => {
  state.filterText = event.target.value.trim().toLowerCase();
  render();
});

onlyErrorsInput.addEventListener("change", (event) => {
  state.onlyErrors = !!event.target.checked;
  render();
});

clearButton.addEventListener("click", () => {
  state.entries = [];
  state.selectedId = null;
  statusLabel.textContent = "Listening for network traffic...";
  render();
});

chrome.devtools.network.onRequestFinished.addListener(handleFinishedRequest);
render();
