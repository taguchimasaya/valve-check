const features = [
  {
    title: "機器マスター / QR発行",
    desc: "機器マスターをインポートし、機器ごとにQRコードを発行します。",
    status: "未実装",
  },
  {
    title: "チェックリスト取込",
    desc: "既存のExcelチェックリストを読み込み、点検項目として登録します。",
    status: "未実装",
  },
  {
    title: "現場チェック（iPad）",
    desc: "QRコードを読み取り、対象バルブのチェックリストにその場で記録します。",
    status: "未実装",
  },
  {
    title: "点検ダッシュボード（制御室PC）",
    desc: "現場のチェック状況をリアルタイムに確認します。",
    status: "未実装",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-16 dark:bg-black">
      <div className="mx-auto max-w-3xl">
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Valve Inspection App
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          バルブ点検アプリ
        </h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          QRコードでバルブ点検を担保する現場点検システムです。開発中のため、下記機能は順次追加されます。
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {features.map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-medium text-zinc-900 dark:text-zinc-50">
                  {f.title}
                </h2>
                <span className="whitespace-nowrap rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  {f.status}
                </span>
              </div>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                {f.desc}
              </p>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
