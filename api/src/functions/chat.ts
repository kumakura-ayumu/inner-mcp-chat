import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../mcp-tools.js";
import {
  GoogleGenAI,
  Type,
  type FunctionDeclaration,
  type Schema,
  type Content,
} from "@google/genai";

// ── 型 ───────────────────────────────────────────────────────────────────────

/** JSON Schema (MCP が返す inputSchema) の最小型 */
interface JsonSchemaObject {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
}

/** MCP callTool の content 要素 */
interface ContentItem {
  type: string;
  text?: string;
}

/** リクエストボディの型 */
interface ChatRequestBody {
  message: string;
}

// ── ユーティリティ: MCP ToolSchema → Gemini FunctionDeclaration ─────────────

function toGeminiType(jsonType: string | undefined): Type {
  switch (jsonType) {
    case "string":
      return Type.STRING;
    case "number":
      return Type.NUMBER;
    case "integer":
      return Type.INTEGER;
    case "boolean":
      return Type.BOOLEAN;
    case "array":
      return Type.ARRAY;
    case "object":
    default:
      return Type.OBJECT;
  }
}

function toGeminiSchema(prop: JsonSchemaObject): Schema {
  const type = toGeminiType(prop.type);
  const base: Schema = { type };
  if (prop.description) base.description = prop.description;

  if (type === Type.OBJECT && prop.properties) {
    base.properties = Object.fromEntries(
      Object.entries(prop.properties).map(([k, v]) => [k, toGeminiSchema(v)])
    );
    if (prop.required) base.required = prop.required;
  }

  return base;
}

function mapMcpToolsToGemini(mcpTools: Tool[]): FunctionDeclaration[] {
  return mcpTools.map((tool) => {
    const decl: FunctionDeclaration = {
      name: tool.name,
      description: tool.description ?? "",
    };

    const inputSchema = tool.inputSchema as JsonSchemaObject | undefined;
    if (
      inputSchema?.properties &&
      Object.keys(inputSchema.properties).length > 0
    ) {
      decl.parameters = toGeminiSchema(inputSchema);
    }

    return decl;
  });
}

// ── Azure Functions v4 ハンドラー ─────────────────────────────────────────────

async function chatHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  // ── ドメインチェック ──────────────────────────────────────────────────────
  const allowedDomain = process.env["ALLOWED_DOMAIN"];
  if (allowedDomain) {
    const principalHeader = request.headers.get("x-ms-client-principal");
    if (principalHeader) {
      try {
        const decoded = Buffer.from(principalHeader, "base64").toString("utf-8");
        const principal = JSON.parse(decoded) as { userDetails?: string };
        const email = (principal.userDetails ?? "").toLowerCase();
        if (!email.endsWith(`@${allowedDomain.toLowerCase()}`)) {
          return {
            status: 403,
            jsonBody: { error: "アクセスが拒否されました。許可されたドメインのアカウントでログインしてください。" },
          };
        }
      } catch {
        return { status: 403, jsonBody: { error: "認証情報の解析に失敗しました。" } };
      }
    }
  }

  const apiKey = process.env["GEMINI_API_KEY"];

  if (!apiKey) {
    return {
      status: 500,
      jsonBody: { error: "GEMINI_API_KEY が設定されていません。" },
    };
  }

  // リクエストボディのパース
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return {
      status: 400,
      jsonBody: {
        error:
          "リクエストボディが不正です。{ message: string } を送信してください。",
      },
    };
  }

  if (!body.message || typeof body.message !== "string") {
    return {
      status: 400,
      jsonBody: { error: "message フィールドが必要です。" },
    };
  }

  const userMessage = body.message;
  context.log(`[chat] ユーザーメッセージ: ${userMessage}`);

  // ── MCP クライアントをインプロセスで初期化 ───────────────────────────────
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const mcpServer = createMcpServer();
  await mcpServer.connect(serverTransport);

  const mcpClient = new Client(
    { name: "inner-mcp-agent-host", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await mcpClient.connect(clientTransport);
    context.log("[chat] MCP サーバー（インプロセス）に接続しました。");

    // ── ツール一覧を取得 ──────────────────────────────────────────────────
    const { tools: mcpTools } = await mcpClient.listTools();
    context.log(
      `[chat] 取得したツール: ${mcpTools.map((t) => t.name).join(", ")}`
    );

    // ── Gemini FunctionDeclaration にマッピング ───────────────────────────
    const geminiTools = [{ functionDeclarations: mapMcpToolsToGemini(mcpTools) }];

    // ── Gemini 1 回目のリクエスト（Function Calling）─────────────────────
    const ai = new GoogleGenAI({ apiKey });

    const firstResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: userMessage,
      config: { tools: geminiTools },
    });

    const functionCalls = firstResponse.functionCalls;

    if (!functionCalls || functionCalls.length === 0) {
      // ツール不使用: Gemini がテキストで直接回答した場合
      context.log("[chat] Gemini がツールを使用せず直接回答しました。");
      const directReply =
        firstResponse.text ||
        (firstResponse.candidates?.[0]?.content?.parts ?? [])
          .filter((p) => !(p as { thought?: boolean }).thought && p.text)
          .map((p) => p.text)
          .join("\n") ||
        "(回答なし)";
      return {
        status: 200,
        jsonBody: { reply: directReply },
      };
    }

    const fc = functionCalls[0];
    if (!fc) {
      throw new Error("FunctionCall の取得に失敗しました。");
    }
    context.log(`[chat] Gemini がツールを指名: "${fc.name}"`);

    // ── MCP ツールを実行 ──────────────────────────────────────────────────
    const toolResult = await mcpClient.callTool({
      name: fc.name ?? "",
      arguments: (fc.args as Record<string, unknown>) ?? {},
    });

    const contentItems = (toolResult.content as ContentItem[]) ?? [];
    const toolText =
      contentItems
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n") || "(結果なし)";

    context.log(`[chat] ツール実行結果: ${toolText}`);

    // ── Gemini 2 回目のリクエスト（最終回答）─────────────────────────────
    // gemini-2.5-flash は thinking モデルのため、1 回目のレスポンスに
    // thought: true のパーツが含まれる場合がある。
    // これを会話履歴にそのまま渡すと 2 回目の text が undefined になるため除外する。
    const modelParts = (firstResponse.candidates?.[0]?.content?.parts ?? []).filter(
      (p) => !(p as { thought?: boolean }).thought
    );

    const history: Content[] = [
      { role: "user", parts: [{ text: userMessage }] },
      {
        role: "model",
        parts: modelParts,
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: fc.name ?? "",
              response: { result: toolText },
            },
          },
        ],
      },
    ];

    const secondResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: history,
    });

    context.log("[chat] Gemini の最終回答を取得しました。");

    const finalReply =
      secondResponse.text ||
      (secondResponse.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => !(p as { thought?: boolean }).thought && p.text)
        .map((p) => p.text)
        .join("\n") ||
      "(回答なし)";

    return {
      status: 200,
      jsonBody: { reply: finalReply },
    };
  } catch (err) {
    context.error("[chat] エラー:", err);
    return {
      status: 500,
      jsonBody: {
        error:
          err instanceof Error
            ? err.message
            : "予期しないエラーが発生しました。",
      },
    };
  } finally {
    // セッションを必ず解放する（MCP サーバー側の transports Map からも削除される）
    await mcpClient.close().catch(() => {});
  }
}

// ── Azure Functions v4 の登録 ─────────────────────────────────────────────────
app.http("chat", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: chatHandler,
});
