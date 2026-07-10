# Rigor

日本語 | [English](README.md)

Rigorは、AIを利用したソフトウェア変更を、後から検証でき、変更リスクに比例して統制できるようにするClaude Codeプラグインです。変更予定からリスク評価、境界の明確なタスク契約、決定的な検証証跡、構造化されたエスカレーションまたはレビューbundle、pull requestでの独立検証までを一つの流れにします。

RigorはLLM判定器ではありません。format、lint、型検査、テスト、ビルド、Git差分、policy比較、証跡の関連付けはTypeScript CLIが判定します。Skillsとreviewer agentは作業を整理し、ローカルHookは早期フィードバックを返します。権威あるマージ境界はGitHub CIと独立した人間承認です。

## 保証すること／保証しないこと

文書どおりに運用した場合、Rigorは次を決定的に処理します。

- version付きpolicy・入力schemaの検証
- 最も高いrisk tier、保護対象、外部送信可否、人間承認要否、根拠、停止条件の導出
- path traversal、危険なパス、setup時のリポジトリ外symlinkの拒否
- setup対象の既存ファイルが生成内容と異なる場合の上書き拒否
- 契約範囲と変更パスの照合、およびshellを介さない検証コマンド実行
- 生出力を保存せず、status、duration、exit code、digestだけを記録
- CIでのbase/head差分再導出、base policy/check比較、テスト削除検出、証跡関連付け、check再実行

Rigorは、policyや受け入れ条件の正しさ、すべてのsecret検出、テストの意味的十分性、ローカル実行バイナリの真正性、ローカルHookの迂回防止、本番反映の安全性、GitHub管理者によるbypass防止を保証しません。外部送信可否は判定結果であり、Rigor自身は何もuploadしません。secret scanner、DLP、sandbox、identity、deployment approval、branch protection、CODEOWNERS、人間の判断は別の統制です。

設計の根拠は[プロダクト定義](docs/product.md)、[脅威モデル](docs/threat-model.md)、[アーキテクチャ](docs/architecture.md)を参照してください。

## 必要環境とインストール

- Claude Code 2.1.206以上（2.1.206で公式validation済み）
- Node.js 20以上
- Git
- macOSまたはLinux（MVPのlauncherはPOSIX shell）

Claude Code内でGitHub marketplaceからインストールします。

```text
/plugin marketplace add xhnagata/rigor
/plugin install rigor@rigor-tools
```

開発時はこのリポジトリをcloneし、`npm ci && npm run build` の後に `claude --plugin-dir .` で起動できます。有効化されたプラグインはHookを実行できるため、確認済みのリポジトリだけを信頼してください。

## 5分quick start

導入対象のGitリポジトリで実行します。

```sh
rigor setup
```

生成された `.rigor/policy.json`、`.rigor/rigor-ci.cjs`、`.rigor/.gitignore`、`.rigor/intent.example.json`、`.github/workflows/rigor.yml` を確認してcommitします。intentはリポジトリ外、またはタスク範囲に含めるパスへ置きます。

```json
{
  "schemaVersion": "rigor.intent.v1",
  "taskId": "APP-123",
  "summary": "境界の明確なparserを追加する",
  "plannedPaths": ["src/parser.ts", "test/parser.test.ts"],
  "operations": ["create", "test"]
}
```

preflightを実行し、次にcontract入力を作ります。

```sh
rigor preflight --intent /tmp/intent.json
```

```json
{
  "schemaVersion": "rigor.contract-input.v1",
  "taskId": "APP-123",
  "acceptanceCriteria": [
    "正常入力をparseできる",
    "不正入力はtyped errorを返す"
  ],
  "allowedPaths": ["src/parser.ts", "test/parser.test.ts"],
  "constraints": ["network accessなし", "runtime dependency追加なし"]
}
```

各コマンドが表示する保存先を次のコマンドへ渡します。

```sh
rigor contract --preflight .rigor/evidence/APP-123/preflight.json --input /tmp/contract-input.json
# 契約範囲内で実装
rigor verify --contract .rigor/evidence/APP-123/contract.json
rigor review --contract .rigor/evidence/APP-123/contract.json --preflight .rigor/evidence/APP-123/preflight.json --verification .rigor/evidence/APP-123/verification.json
```

変更と一緒に証跡をcommitします。CIはcode差分の再導出時には証跡ファイルを除外しますが、その関連付けとpolicy適合性を検証し、checkを独立に再実行します。

## 日常フロー

手動Skillの `/rigor:preflight`、`/rigor:contract`、`/rigor:verify`、`/rigor:escalate`、`/rigor:review`、`/rigor:retrospect` が同じCLIフローを案内します。推測によるSkill自動実行が統制を暗黙に成立させないよう、意図的に手動実行にしています。

実行順序は、編集前にpreflightとcontract、全編集（再buildした `dist/rigor.cjs` を含む）の完了後に `rigor verify`、次に `rigor review`、最後にcodeとevidenceを1つのcommitにまとめる、の順を推奨します。verificationはworktreeの未commit変更を記録するため、最後の編集より前にverifyしたり途中でcommitを挟むと、pull request全体の変更を覆わないevidenceになりCIが拒否します。artifactはwrite-onceで、taskの `preflight.json`、`contract.json`、`verification.json`、`review.json` は上書きされません。scopeが変わった場合や保存後に再verifyが必要な場合は、`APP-123-R2` のような新しいtask IDで始め、以前のartifactは残してください。

検証失敗を解消できない場合は `rigor.escalation-input.v1` の入力を作り、`facts`、`attempts`、`disprovedHypotheses`、`speculation`、`requestedDecision` を分離します。同一の試行は拒否されます。`rigor retrospect` はgitignoredの `.rigor/events.jsonl` から秘匿化された件数だけを集計します。

CLIの安定したexit codeは、`0`が成功、`2`がpolicy/検証違反、`3`が入力またはrepository stateの不正、`4`が予期しない内部エラーです。エラーにはsubprocessの生出力を含めません。

## 配置されるもの

プラグイン側には次を含みます。

- packaging用の `.claude-plugin/plugin.json` と `marketplace.json`
- agent workflowを記述する `skills/`
- 読み取り専用で助言のみを行う `agents/rigor-reviewer.md`
- 5秒timeoutの早期フィードバック用 `hooks/hooks.json`
- deterministic runtimeの `bin/rigor` と `dist/rigor.cjs`

`rigor setup` が対象リポジトリへ置くのはquick startに示した5ファイルだけです。再実行は冪等です。生成内容と異なる既存ファイルやsymlinkがあれば、何も上書きせずconflictとして停止します。`rigor upgrade` も同じ安全な照合を行い、差異は手動確認を要求します。

未導入リポジトリではHookは何もしません。`.rigor/` があるのにpolicyが欠損・破損している場合は早期にblockします。ただしHookは迂回可能であり、CIが強制点です。

## Policy設定

生成policyは保守的な初期値であり、普遍的な正解ではありません。Rigor/workflow、credential、認証、権限、課金、migration、infrastructureを保護し、runtime codeをhighと判定し、複数ruleのうち最も高いtierを採用します。globはsegment-awareな `*`、`?`、`**` のみで、すべてのplatformでcase-sensitiveです。

checkはshell文字列ではなく、実行ファイルと引数配列で定義します。

```json
{
  "id": "project-test",
  "command": "npm",
  "args": ["test"],
  "tiers": ["medium", "high", "critical"],
  "timeoutMs": 300000
}
```

対象projectのformat、lint、typecheck、test、buildを追加してください。policy/check変更は保護対象であり、CIはbaseにあるrule/checkの削除・変更を拒否します。新しい統制を先にreview済み追加し、古い統制の廃止は別の統制された変更で行います。公開schemaは [`schemas/`](schemas/) にあります。

## GitHub側の強制設定

`main` のrulesetまたはbranch protectionで次を設定してください。

1. pull requestを必須とし、生成された `rigor` checkとproject固有testをrequired checksにする。
2. 1名以上のapprovalを必須とし、新commitで古いapprovalを無効化する。
3. `.rigor/**`、`.github/workflows/**`、認証、権限、課金、migration、infrastructure、deploymentをCODEOWNERS対象にする。
4. 実装者本人だけのapprovalではmergeできないようにする。
5. force-push、branch削除、bypassを制限する。
6. 組織policyが許す場合は管理者にもrulesetを適用する。

`rigor governance --repo owner/name` は、これらの設定をGitHub APIに対して読み取り専用で検証します。

```sh
rigor governance --repo owner/name --branch main --required-check rigor
```

有効なbranch rules（rulesets）、classic branch protection、CODEOWNERS（`.github/CODEOWNERS`、`CODEOWNERS`、`docs/CODEOWNERS`）、deployment environmentsを読み取り、pull request必須、1名以上のapproval、古いapprovalの無効化、code owner review、last-push approval、必須 `rigor` status check、force-push/削除のブロック、CODEOWNERSのsampledカバレッジ、全deployment environmentの保護ruleについて、要件ごとの判定を出力します。commandは `api.github.com` へのGETのみを送信し、tokenは `RIGOR_GITHUB_TOKEN`、`GITHUB_TOKEN`、`GH_TOKEN` から読む最小権限の読み取りtokenを任意で使い、redirectを拒否し、10秒でtimeoutし、過大または解読不能なresponseはunverifiableとして破棄し、設定の書き込みは一切行いません。設定変更は別途承認された人間の操作のままです。終了codeは、全要件が満たされた場合のみ `0`、要件不成立または権限不足で読めない場合は `2` で、scope不足は静かに合格せずfail closedになります。CODEOWNERSの確認はpolicy保護globごとに代表path 1件を検査します。サンプルが未カバーなら確実な欠落として失敗しますが、サンプルがカバーされていてもglob全体のカバレッジの証明にはならず、早期警告に留まります。照合は文書化したlast-match-winsのsubset（anchoring、`*`、`**`、`?`、escaped space、owner無しentryによるカバレッジ解除）を大文字小文字区別で実装しています。classic protectionの読み取りにはrepository administration read scopeが必要で、rulesets、contents、environmentsはrepository readで読めます。この読み取り専用GitHub API信頼境界は [threat model](docs/threat-model.md) に記載しています。

RigorはこれらのGitHub設定を構成することはできず、ローカルcommandの成功表示やモデルの「合格」宣言だけでは引き続き不十分です。権威はGitHub側の設定と独立した人間承認にあります。

## 開発、テスト、リリース

```sh
npm ci
npm run test:all
npm run bench
claude plugin validate . --strict
```

`test:all` はformat check、ESLint、strict TypeScript、unit/integration/E2E、bundle再生成、plugin構造、local linkを検証します。E2Eは空の一時Gitリポジトリでsetupから独立CIまでを実行し、policy check改変と既存test削除の検出も確認します。Hook benchmarkのp95回帰上限は250 msです。

release時は `CHANGELOG.md` を更新し、`package.json` と `.claude-plugin/plugin.json` を同じversionへ上げ、`dist/rigor.cjs` を再生成してcommitします。全gateと公式validation後、`vX.Y.Z` tagをpublishします。manifest versionがClaude Codeのcache versionになるため、更新配布にはversion bumpが必要です。

## セキュリティ前提と既知の限界

証跡はversion controlへ入るため、secretを含めてはいけません。Rigorはcheckの生出力を保存しませんが、利用者が入力した散文をsanitizeできません。intent、contract、escalationは必要最小限にしてください。悪意あるpolicyは悪意あるcommandを実行できるため、policy変更をCODEOWNERSとbase/head reviewで保護してください。

[MVP limitations](docs/mvp-limitations.md) に意図的な未実装とGitHub Issueを記録しています。Windows launcher、暗号学的provenance/attestation、意味的なtest品質解析、GitHub設定の書き込みは保証範囲外です。`rigor governance` はGitHub側設定を読み取り専用で検証しますが、変更はできません。
