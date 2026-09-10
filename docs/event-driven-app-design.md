# mini-restate を使ったイベント駆動アプリケーション設計案

この文書は議論用の設計案であり、実装済みの仕様ではない。

## 目的と前提

GitHub、Slack、メール、CLI などから更新をイベントとして収集し、SQLite に記録する。登録したコンシューマーがイベントに反応し、ユーザーに必要な処理を行う。

収集対象は「何が起きたか」とその参照だけであり、コンテンツは取得しない。コメント本文、PR の説明、メール本文、メッセージのプレビューをイベントに含めない。

コンシューマーは必要に応じてコンテンツを取得する。Source はイベントと参照だけを収集し、コンテンツの取得と利用は Consumer の責務とする。取得したコンテンツの永続化をどこまで許容するかは別途決める。

## 全体構成

```text
GitHub / Slack / メール / CLI
             │
       Source：変更を検出
             │
             ▼
     Event Store：SQLite
      イベントと参照だけ保存
             │
      Dispatcher：購読を照合
             │
       Consumer ごとの配信記録
             │
             ▼
     mini-restate の workflow
       必要な処理・リトライ
```

mini-restate は、失敗や再起動をまたいで処理を進める実行基盤として使う。イベント収集・保存・購読・配信管理はアプリケーション層に置く。

## イベントモデル

```ts
type Event = {
  id: string;
  seq: number;            // ローカルでの記録順
  sourceId: string;       // 接続設定の識別子
  sourceEventKey: string; // ソース内での重複排除キー
  type: string;
  schemaVersion: number;
  occurredAt: string | null;
  recordedAt: string;
  subject: {
    service: string;
    kind: string;
    id: string;
    parentId?: string;
    url?: string;
  };
  actorId?: string;
};
```

例えば `github.pr.comment.created` は、コメント ID、所属する PR の参照、発生時刻などを持つ。外部 API のレスポンスを自由な payload に格納せず、イベント種別ごとに保存可能なフィールドを定義する。

イベントは追記型とする。同じコメントの追加と編集は別イベントなので、対象 ID だけを重複排除キーにしない。出来事の ID、または操作種別とリビジョンなどを使う。基本の一意制約は `(sourceId, sourceEventKey)` とする。

## Source

Source は変更情報の受信、イベント形式への変換、重複排除、保存、取得位置の管理までを担当する。コンシューマーには依存せず、処理側が失敗していても収集を続けられる。

登録 API の案：

```ts
defineSource({
  id: "github-personal",
  every: "1m",
  async poll({ cursor }) {
    return {
      events: [/* 正規化したイベント */],
      nextCursor: "...",
    };
  },
});
```

イベント保存と取得位置更新を同一 SQLite トランザクションで行う。Source ごとの収集を直列化し、保存時にも取得位置の世代を確認して、古い取得結果による巻き戻しを防ぐ。

本文を取得せずに検出できる出来事は、接続先の仕組みに依存する。現在の状態の差分だけでは途中の全変更を復元できないため、「更新を観測した」と「コメント追加を検出した」は区別する。個別サービスの API 選定と検証は今後行う。

## Consumer

Consumer は購読条件と workflow から構成する。登録 API の案：

```ts
defineConsumer({
  id: "pr-comment-notifier",
  version: "1",
  subscription: {
    types: ["github.pr.comment.created"],
    sourceIds: ["github-personal"],
  },
  async run(ctx, event) {
    await ctx.run("notify", () =>
      notifyReference(event.subject, {
        idempotencyKey: `${ctx.invocationId}:notify`,
      }),
    );
  },
});
```

イベントの収集と利用は必ず分離する。Source は保存までを行い、その場で Consumer を実行しない。同じイベントを複数の Consumer が独立して利用できる。イベント自体に共有の「処理済み」フラグを付けず、配信・処理状況は Consumer ごとに管理する。

1 イベント × 1 Consumer を 1 invocation とする。通知と分析などは独立して実行・再試行できる。購読条件はイベント種別・Source・対象 ID などのメタデータに限定し、本文を使った判断は Consumer 内で行う。

## 永続的な配信管理

| テーブル | 役割 |
|---|---|
| events | 変更しないイベント履歴 |
| source_checkpoints | Source ごとの取得位置 |
| consumer_subscriptions | 購読開始位置・照合済み位置 |
| deliveries | Consumer への配信と対応する invocation |

Dispatcher は `events.seq` 順に購読条件を照合する。配信記録の作成と照合済み位置の更新を同一トランザクションで行う。配信には Consumer・イベント・配信世代の一意制約を設ける。

未投入の配信を mini-restate に渡す：

```ts
const result = await runtime.invoke({
  workflow: consumerWorkflowName,
  input: { eventId: delivery.eventId },
  idempotencyKey: `delivery:${delivery.id}`,
});
```

返された invocation ID を配信記録に保存する。投入直後にクラッシュしても、同じキーで再投入すれば既存の invocation を取得できる。この機能は現在の RuntimeApi に存在する。

アプリ用 `events.sqlite` と mini-restate 用 `state.sqlite` は完全に分離する。接続・スキーマ・マイグレーションをそれぞれが所有し、DB の ATTACH、相互のテーブルへの直接アクセス、DB をまたぐトランザクションは使わない。連携は RuntimeApi（または CLI / HTTP）経由で行う。Consumer はアプリ側のイベント読み取りインターフェースで eventId を解決する。

配信側は投入状況を持ち、実行中・失敗・完了の正本は mini-restate に置く。DB 間の連携は永続的な配信記録と冪等な再投入で復旧する。冪等な再投入に必要な invocation 記録を、配信の復旧期間中は保持する。

## コンテンツと journal の境界

`ctx.run("fetch-comment", fetchComment)` は戻り値を journal に保存するため、本文を返すとイベントストア以外の SQLite にコンテンツが残る。

イベント収集とイベント利用の分離は確定事項であり、Consumer 内部でコンテンツをどう扱うかとは別の設計判断である。各 Consumer は同じイベントの参照から、必要に応じてコンテンツを取得する。共有のコンテンツ取得処理やキャッシュを必須にはしない。

イベントストアにはコンテンツを保存しない。Consumer が取得した本文や派生した要約を journal・出力・ログに保存してよいかは未決事項とする。保存を禁止する場合のステップ設計は、この方針を決めてから検討する。

コンテンツを再取得する際には、内容の変更や削除があり得る。イベント発生時の本文を再現する保証は持たない。

外部への副作用は at-least-once であり、必要に応じて相手側の冪等性キーで重複を防ぐ。

## 初期版の運用方針案

- 新規 Consumer は登録後のイベントから処理する。過去分は範囲を指定したバックフィルで処理する。
- 失敗の再試行は既存 invocation を使う。完了済みイベントの再処理は新しい配信世代を作る。
- コードのバージョン更新だけでは過去のイベントを自動実行しない。進行中 invocation のバージョンとの整合性を管理する。
- Consumer の完了順は標準では保証しない。必要になった場合に PR などの対象単位で直列化する。
- ポーリングは mini-restate の定期実行を使い、`catchUp: latest` で起動して Source の取得位置から続きを読む。回収可能な範囲は接続先の履歴保持に依存する。

## 定期実行と責務分担

mini-restate には定期実行の仕組みがすでにある。`RuntimeApi.createSchedule()` が実行間隔と次回時刻を保存し、`ScheduleMaterializer` が期限を迎えたスケジュールを invocation に変換する。`RuntimeApi.tick()` はスケジュールの具体化、孤立した実行の復旧、タイマーの再開、実行可能な workflow の処理を行う。

ただし、停止中のプロセスが自分自身を起動する機能ではない。常駐しない運用では launchd などが `mini-restate tick` を定期的に起動する。常駐運用では `mini-restate serve` が runner loop を動かす。

初期運用は `mini-restate tick` を定期起動する方式を基本とする。例えば launchd が毎分 `mini-restate tick --max-runs 20` を起動し、その都度、期限を迎えた収集・配信・Consumer の処理を進めて終了する。HTTP サーバーの常駐は必須にしない。スケジュールの登録は初期設定・設定変更時に行い、毎回の tick で作り直さない。

処理開始の粒度は tick の起動間隔に依存し、マシンのスリープ中は動かない。上限を超えた仕事は次回へ持ち越すため、起動間隔と max-runs は処理量に合わせて調整する。max-runs は実行件数の上限であり、一つの Consumer の処理時間を制限するものではない。CLI によるイベント投入もアプリ DB への保存までとし、その後の配信は tick が進める。

| 層 | 責務 |
|---|---|
| launchd など | 停止しているプロセスの定期起動 |
| mini-restate | スケジュール、workflow 実行、journal、リトライ、タイマー、runner の排他 |
| アプリケーション | Source / Consumer 登録、イベント保存、取得位置、購読照合、配信管理 |

構成案として、Source のポーリングと Dispatcher のバッチ処理をそれぞれ通常の workflow として登録し、mini-restate のスケジュールで動かす。Consumer は配信ごとに投入する。Dispatcher からの投入は `wait: false` とし、Consumer の完了を待たずに終了する。各バッチには処理量の上限を設ける。

この構成なら、全体のスケジュールを独自に管理する supervisor は不要である。アプリ起動時に登録定義を workflow と schedule に対応付ける初期化処理は必要だが、実行時刻の管理は mini-restate に任せられる。アプリ固有の登録 API や変換処理はこれから実装する。

現状の runner は invocation を一つずつ実行するため、長時間の Consumer は収集や配信の開始を遅らせる。独立した責務であることは同時実行の保証ではない。まず短い処理単位で運用し、必要なら実行基盤の並行性を別途検討する。

## 実装順序案

1. CLI Source とイベント保存を実装する。
2. 購読照合と永続的な配信記録を実装する。
3. Consumer を mini-restate の workflow として起動する。
4. 重複投入、再起動、複数 Consumer、失敗の再試行を検証する。
5. 外部 Source を一つ追加し、本文を取得しない収集が成立するか確認する。

## 未決事項

- 本文・要約・処理結果の永続化をどこまで許容するか。
- 最初の外部 Source と対象イベント種別。
- 初回収集の開始位置と履歴保持期間。
- 対象単位で厳密な順序が必要な Consumer があるか。
