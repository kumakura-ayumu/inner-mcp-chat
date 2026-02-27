import { useState, useRef, useEffect } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ClientPrincipal {
  userDetails?: string;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        "こんにちは！インフラ監視 AI アシスタントです。\n「サーバーの状態を確認して」などとメッセージを入力してください。Gemini が MCP ツールを呼び出してサーバーメトリクスを分析します。",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  // 認証情報取得 + ドメインチェック
  useEffect(() => {
    const allowedDomain = import.meta.env.VITE_ALLOWED_DOMAIN as string | undefined;
    fetch("/.auth/me")
      .then((res) => res.json())
      .then((data: { clientPrincipal?: ClientPrincipal | null }) => {
        const email = (data.clientPrincipal?.userDetails ?? "").toLowerCase();
        setUserEmail(email);
        if (allowedDomain && email && !email.endsWith(`@${allowedDomain.toLowerCase()}`)) {
          setAccessDenied(true);
        }
      })
      .catch(() => {})
      .finally(() => setAuthChecked(true));
  }, []);

  // 新しいメッセージが追加されたら自動スクロール
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const userMessage: Message = { role: "user", content: trimmed };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as { error?: string };
        throw new Error(errorData.error ?? `HTTP エラー: ${response.status}`);
      }

      const data = (await response.json()) as { reply: string };
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `エラーが発生しました: ${err instanceof Error ? err.message : "不明なエラー"}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  if (!authChecked) return null;

  if (accessDenied) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-gray-50 gap-4">
        <p className="text-xl font-semibold text-gray-700">アクセスが拒否されました</p>
        <p className="text-sm text-gray-500">許可されたドメインのアカウントでログインしてください。</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* ヘッダー */}
      <header className="bg-blue-700 text-white px-6 py-4 shadow-md flex-shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">インフラ監視 AI アシスタント</h1>
          <p className="text-blue-200 text-sm mt-0.5">Powered by Gemini + MCP</p>
        </div>
        <span className="text-white text-sm opacity-80">
          {userEmail || "ローカル開発中（未ログイン）"}
        </span>
      </header>

      {/* チャット表示エリア */}
      <main className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-blue-600 text-white rounded-br-sm"
                  : "bg-white text-gray-800 border border-gray-200 rounded-bl-sm"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {/* 分析中スピナー */}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-200 rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm flex items-center gap-2">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" />
              </div>
              <span className="text-gray-500 text-sm">分析中...</span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </main>

      {/* 入力エリア */}
      <footer className="bg-white border-t border-gray-200 px-4 py-3 flex-shrink-0">
        <div className="flex gap-3 items-end max-w-4xl mx-auto">
          <textarea
            className="flex-1 resize-none border border-gray-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent leading-relaxed disabled:bg-gray-50 disabled:text-gray-400"
            placeholder="メッセージを入力... (Enter で送信、Shift+Enter で改行)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={loading}
            style={{ minHeight: "44px", maxHeight: "128px" }}
          />
          <button
            onClick={() => void sendMessage()}
            disabled={loading || !input.trim()}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium px-5 py-2.5 rounded-xl transition-colors text-sm whitespace-nowrap"
          >
            送信
          </button>
        </div>
      </footer>
    </div>
  );
}
