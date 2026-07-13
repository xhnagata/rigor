# Rigor

日本語 | [English](README.md)

最新版: [v0.15.0](https://github.com/xhnagata/rigor/releases/tag/v0.15.0)（immutable、2026-07-13リリース）。

Rigorは、AIを利用したソフトウェア変更を、後から検証でき、変更リスクに比例して統制できるようにするClaude Codeプラグインです。変更予定からリスク評価、境界の明確なタスク契約、任意のpolicy制約付きモデルルーティングpreview、決定的な検証証跡、構造化されたエスカレーションまたはレビューbundle、pull requestでの独立検証までを一つの流れにします。

RigorはLLM判定器ではありません。format、lint、型検査、テスト、ビルド、Git差分、policy比較、証跡の関連付けはTypeScript CLIが判定します。Skillsとreviewer agentは作業を整理し、ローカルHookは早期フィードバックを返します。権威あるマージ境界はGitHub CIと独立した人間承認です。

## 保証すること／保証しないこと

文書どおりに運用した場合、Rigorは次を決定的に処理します。

- version付きpolicy・入力schemaの検証
- 最も高いrisk tier、保護対象、外部送信可否、人間承認要否、根拠、停止条件の導出
- path traversal、危険なパス、setup時のリポジトリ外symlinkの拒否
- setup対象の既存ファイルが生成内容と異なる場合の上書き拒否
- 契約範囲と変更パスの照合、およびshellを介さない検証コマンド実行
- 明示的な能力、用途、追加外部送信、相対コスト制約によるモデル候補のpreview（モデル呼び出しなし）
- 生出力を保存せず、status、duration、exit code、digestだけを記録
- CIでのbase/head差分再導出、base policy/check比較、テスト削除検出、証跡関連付け、check再実行

Rigorは、policyや受け入れ条件の正しさ、すべてのsecret検出、テストの意味的十分性、ローカル実行バイナリの真正性、ローカルHookの迂回防止、本番反映の安全性、GitHub管理者によるbypass防止を保証しません。外部送信可否は判定結果であり、決定的CLIはrepository contentをuploadしません。明示的に実行されたorchestration Skillは、policy gate通過後に限り、限定したcontextをClaude Codeまたは`codex-plugin-cc`へ委譲できます。secret scanner、DLP、sandbox、identity、deployment approval、branch protection、CODEOWNERS、人間の判断は別の統制です。

設計の根拠は[プロダクト定義](docs/product.md)、[脅威モデル](docs/threat-model.md)、[アーキテクチャ](docs/architecture.md)を参照してください。

## 現在の成熟度（v0.15.0）

Rigorは、追加のprocess control layerとして限定的なpilotに利用できますが、単独で本番のsecurity controlやcompliance controlを担える段階ではありません。評価時には次の制約が重要です。

- 生成されるpolicyが実行するのは`git diff --check`だけです。Rigor CIを意味のあるquality gateとして扱う前に、repository固有のformat、lint、typecheck、test、build、security checkを追加する必要があります。
- `rigor ci`はpull requestのbase/head pathを独立に導出し、既存rule/checkの変更または削除を拒否し、test削除を検出し、設定済みcheckを再実行します。weakening比較は他のすべてのpolicy fieldを対象としておらず、たとえば`ci.requireEvidence`、`defaultTier`、`stopConditions`の変更をweakeningとして分類しません。また、現在のevidence linkageは、contributorがcommitしたevidenceを暗号学的に認証せず、pull request diffが`contract.allowedPaths`内かを独立に再計算せず、保存されたverificationの`treeHash`をpull request headへbindingしません。したがってevidenceはreview可能な整合性recordであり、local lifecycleが主張どおりに実行されたことの証明ではありません。project CI、保護されたGitHub設定、独立した人間承認が引き続き必要です。
- routing、availability、escalation、consultationのdecisionは決定的または明示的にadvisoryですが、実運用上の効果はまだ実証されていません。v0.15.0時点で、このrepositoryには実taskの`outcome.json`がcommitされておらず、実行可能なevaluation report/replayはsynthetic fixtureを使用します。そのため、現在のrouting thresholdがacceptance rate、品質、経過時間、costを改善するとは主張しません。
- test-integrityのpromotionとrollback機構はありますが、配布されるactive registryは存在せず、enforceされる弱体化signalはゼロです。意味的なtest品質は人間reviewの責任です。
- 検証は主に単一maintainerによるこのrepository自身のdogfoodingです。複数repository、複数team、Windowsでの広範な検証実績はまだありません。
- 完全なworkflowは意図的に明示的でevidence量が多く、advanced orchestrationは複数command、JSON input、append-only/write-once artifactにまたがります。広範に導入する前に、限定されたrepositoryでpilotし、review価値とoperator負荷を測定してください。

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

生成されたworkflowを必須checkとして有効にする前に、既定の`git-diff-check`をrepositoryの実際の検証commandで置き換えるか拡張してください。生成時の既定値だけではwhitespace errorを検査するだけで、behaviorやacceptance criteriaは検証しません。

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

実装前にルーティングをpreviewする場合は、明示的な評価入力とprofileを用意します。

```json
{
  "schemaVersion": "rigor.routing-input.v1",
  "taskId": "APP-123",
  "purpose": "implementation",
  "signals": {
    "complexity": "medium",
    "ambiguity": "low",
    "novelty": "low",
    "verificationStrength": "strong"
  },
  "assessmentReasons": [
    "既存patternに沿った限定的な変更で、決定的なtestがある"
  ],
  "budget": {
    "maxAttempts": 2,
    "maxDurationMs": 600000,
    "maxRelativeCost": 100
  }
}
```

```json
{
  "schemaVersion": "rigor.model-profiles.v1",
  "candidates": [
    {
      "id": "claude-standard",
      "provider": "claude",
      "capabilityClass": "standard",
      "purposes": ["implementation", "review"],
      "relativeCost": 20,
      "requiresAdditionalExternalTransmission": false,
      "enabled": true
    },
    {
      "id": "codex-consult",
      "provider": "codex-plugin-cc",
      "capabilityClass": "frontier",
      "purposes": ["consultation", "adversarial-review", "rescue"],
      "relativeCost": 50,
      "requiresAdditionalExternalTransmission": true,
      "enabled": true
    }
  ]
}
```

```sh
rigor route --dry-run --preflight .rigor/evidence/APP-123/preflight.json --input /tmp/routing-input.json --profiles /tmp/model-profiles.json
```

このcommandはモデルを呼び出さず、証跡も保存しません。`relativeCost`は設定された比較用weightであり、観測済み価格ではありません。詳細は[モデルルーティングとオーケストレーション](docs/orchestration.md)を参照してください。

現在の環境が実際にどの候補を起動できるかを観測するには、versioned availability reportを生成し、ルーティング前にunavailable/incompatibleな候補を除外させます。

```sh
rigor availability --profiles /tmp/model-profiles.json > /tmp/availability.json
rigor route --dry-run --preflight .rigor/evidence/APP-123/preflight.json --input /tmp/routing-input.json --profiles /tmp/model-profiles.json --availability /tmp/availability.json
```

`rigor availability`は各候補を`available`、`unavailable`、`unknown`、`incompatible`のいずれか一つに標識します。判定は文書化された限定的なローカルインターフェース（固定された環境変数の集合）のみを読み取り、インストール、認証、network送信は一切行いません。`codex-plugin-cc`のpresence変数はオーケストレーターが宣言するチャネルであり、pluginの直接観測ではありません。認識できない宣言や宣言の欠落は`unknown`のままです。availabilityはattestationではなく観測です。probingが未対応または失敗した場合は`available`ではなく`unknown`として記録し、unavailable/incompatibleな候補はattempt開始前に除外され、黙って別modelに差し替えられることはなく、設定上のmodel identityは`unverified`のままです。`codex-plugin-cc`が存在しない場合、それを必要とする候補のみを除外します。runtimeのmodel identity、reasoning effort、usage、costはunverified/unknownのままです。

自律実装では選択planを保存し、委譲attemptの前後を記録します。

```sh
rigor route --record --preflight .rigor/evidence/APP-123/preflight.json --contract .rigor/evidence/APP-123/contract.json --input /tmp/routing-input.json --profiles /tmp/model-profiles.json
rigor attempt-start --plan .rigor/evidence/APP-123/routing/routing-plan_ID.json --contract .rigor/evidence/APP-123/contract.json
# 実装を委譲し、verify --dry-run後、成功時にrigor verifyを保存
rigor attempt-finish --session .rigor/evidence/APP-123/attempts/attempt-session_ID.json --contract .rigor/evidence/APP-123/contract.json --input /tmp/attempt-result.json --verification .rigor/evidence/APP-123/verification.json
```

completed attemptには、関連付けられたpassing verificationが必要です。失敗attemptは`verify --dry-run`を使うため、再試行前にtaskのwrite-once verification artifactを消費しません。設定されたprovider/model identityはruntime attestationとはせず、unverifiedとして記録します。

任意のCodex相談は、append-only snapshotで前後を囲みます。

```sh
rigor consult-start --preflight .rigor/evidence/APP-123/preflight.json --input /tmp/consultation-request.json
# codex-plugin-ccを通じて相談
rigor consult-finish --session .rigor/evidence/APP-123/consultations/consultation-session_ID.json --input /tmp/consultation-result.json
```

読み取り専用相談中にrepository content、changed path、HEADが変化した場合、`consult-finish`は失敗します。保存するのは正規化したsummaryと取得できた外部IDだけで、生のmodel transcriptは保存しません。

reviewの後に、taskの処遇を記録し証跡へ関連付けます。

```sh
rigor outcome --input /tmp/outcome-input.json --attempt .rigor/evidence/APP-123/attempts/attempt_ID.json --verification .rigor/evidence/APP-123/verification.json --review .rigor/evidence/APP-123/review.json
```

`outcome`はprovider、model、capability class、attempt/verification/review識別子を入力任せにせずリンク先artifactから複写します。矛盾する主張にはfail closedします。`accepted`にはcompletedなattemptとリンクされた合格verificationが必要で、`reverted`やescaped-defectのoutcomeは`accepted`でなければならず、attemptがリンクされている場合`retryCount`は`attempt.sequence - 1`と一致しなければなりません。token数、provider cost、reasoning effort、model identityはmeasured-or-unavailableとして保存し、`usage.status`が`recorded`でない場合、数値fieldは`null`として永続化します。設定上のmodel identityは`attestation: "unverified"`で記録し、provider costはRigorが検証した請求額ではなく報告された測定値であり、ルーティングの`relativeCost`は抽象的なルーティング重みであってprovider invoiceでも実測の金額でもありません。

変更と一緒に証跡をcommitします。CIはcode差分の再導出時には証跡ファイルを除外しますが、その関連付けとpolicy適合性を検証し、checkを独立に再実行します。

## 日常フロー

手動Skillの `/rigor:preflight`、`/rigor:contract`、`/rigor:route`、`/rigor:attempt`、`/rigor:verify`、`/rigor:escalate`、`/rigor:review`、`/rigor:retrospect` が同じCLIフローを案内します。`/rigor:consult`と`/rigor:orchestrate`は、明示的に起動するmodel利用workflowであり、同じCLI policyと検証commandに制約されます。`/rigor:assess`は、human-authoredのrouting inputがない場合に`/rigor:orchestrate`がrouteするための検証済み `rigor.routing-input.v2`（task characteristics、evidence、confidence）を生成しますが、model自体を指名・選択することはありません。Skillの実行だけで統制が暗黙に成立することはありません。

実行順序は、委譲編集前にpreflight、contract、recorded route、attempt startを行い、全編集（再buildした `dist/rigor.cjs` を含む）の完了後に `rigor verify`とattempt finish、次に `rigor review`、最後にcodeとevidenceを1つのcommitにまとめる、の順を推奨します。verificationはworktreeの未commit変更を記録するため、最後の編集より前にverifyしたり途中でcommitを挟むと、pull request全体の変更を覆わないevidenceになりCIが拒否します。core artifactはwrite-onceで、taskの `preflight.json`、`contract.json`、`verification.json`、`review.json` は上書きされません。routing、attempt、consultation artifactはappend-only collectionです。scopeが変わった場合や保存後に再verifyが必要な場合は、`APP-123-R2` のような新しいtask IDで始め、以前のartifactは残してください。

routing、attempt、consultation recordは現在ローカルのadvisory evidenceです。CIはまだmodel/provider claimを必須化またはattestしません。

検証失敗を解消できない場合は `rigor.escalation-input.v1` の入力を作り、`facts`、`attempts`、`disprovedHypotheses`、`speculation`、`requestedDecision` を分離します。同一の試行は拒否されます。`rigor retrospect` はgitignoredの `.rigor/events.jsonl` の秘匿化件数に加え、各taskの `outcome.json` から候補ごとの成功率（分子と分母を明示）、retry、経過時間、人手介入分、data-completeness件数を集計します。すべての率は分母を、欠損データは件数を報告するため、利用不能な測定値を隠しません。壊れたoutcomeファイルは致命的ではなく、件数として許容します。報告されるcostは測定値であり、ルーティングの`relativeCost`は抽象的なルーティング重みで、provider invoiceでも実測の金額でもありません。

任意で、`rigor test-integrity-scan` はtest弱体化の助言的signalをshadow証跡として記録し、`rigor test-integrity-classify` はattestされていない人手の判定を記録します。`test-integrity-promote`、`test-integrity-replay`、`test-integrity-waive` はversion binding、必須replay、stop/review/advisory、単一結果waiver、fail-closed rollbackを提供します。active registryの正規pathは `.rigor/test-integrity-active.json` ですが、現在は意図的に存在せず、4件のlegacy eventには発火、分類、outcome、version manifestがないため、promote済みsignalはゼロです。詳細は[docs/test-integrity.md](docs/test-integrity.md)を参照してください。

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

有効なbranch rules（rulesets）、classic branch protection、CODEOWNERS（`.github/CODEOWNERS`、`CODEOWNERS`、`docs/CODEOWNERS`）、deployment environmentsを読み取り、pull request必須、1名以上のapproval、古いapprovalの無効化、code owner review、last-push approval、必須 `rigor` status check、force-push/削除のブロック、CODEOWNERSのsampledカバレッジ（早期警告であり完全カバレッジの証明ではない）、全deployment environmentの保護ruleについて、要件ごとの判定を出力します。commandは `api.github.com` へのGETのみを送信し、tokenは `RIGOR_GITHUB_TOKEN`、`GITHUB_TOKEN`、`GH_TOKEN` から読む最小権限の読み取りtokenを任意で使い、redirectを拒否し、10秒でtimeoutし、過大または解読不能なresponseはunverifiableとして破棄し、未取得ページが残るpaginated responseは部分データで判定せずunverifiableとし、設定の書き込みは一切行いません。設定変更は別途承認された人間の操作のままです。終了codeは、全要件が満たされた場合のみ `0`、要件不成立または権限不足で読めない場合は `2` で、scope不足は静かに合格せずfail closedになります。CODEOWNERSの確認はpolicy保護globごとに代表path 1件を検査します。サンプルが未カバーなら確実な欠落として失敗しますが、サンプルがカバーされていてもglob全体のカバレッジの証明にはならず、早期警告に留まります。照合は文書化したlast-match-winsのsubset（anchoring、`*`、`**`、`?`、escaped space、owner無しentryによるカバレッジ解除）を大文字小文字区別で実装しています。classic protectionの読み取りにはrepository administration read scopeが必要で、rulesets、contents、environmentsはrepository readで読めます。この読み取り専用GitHub API信頼境界は [threat model](docs/threat-model.md) に記載しています。

RigorはこれらのGitHub設定を構成することはできず、ローカルcommandの成功表示やモデルの「合格」宣言だけでは引き続き不十分です。権威はGitHub側の設定と独立した人間承認にあります。

## 開発、テスト、リリース

```sh
npm ci
npm run test:all
npm run bench
claude plugin validate . --strict
```

`test:all` はformat check、ESLint、strict TypeScript、unit/integration/E2E、bundle再生成、plugin構造、local linkを検証します。E2Eは空の一時Gitリポジトリでsetupから独立CIまでを実行し、policy check改変と既存test削除の検出も確認します。Hook benchmarkのp95回帰上限は250 msです。

releaseは[リリース手順書](docs/release.md)に従います。release commitは必須check（`rigor` と `quality`）がgreenな保護されたpull request経由でのみ `main` に到達し（直接pushは禁止）、その後に決定的な `rigor release-check` の pre-tag gateを通過して初めて、人がtagとpublishを行います。gateはclean tree、`package.json` と `.claude-plugin/plugin.json` の同期されたversion、`CHANGELOG.md` の該当セクション、fresh buildとbyte一致する `dist/rigor.cjs`、期待するbranchとcommit、そして厳密なSHAに対するGitHub CIの成功を確認します。`--repo` を省くとCIはunverifiableとなり、gateはfail closedします。manifest versionがClaude Codeのcache versionになるため、更新配布にはversion bumpが必要です。

release tagのpushは、`dist/rigor.cjs`、決定的な完全plugin archive、detached release manifestに対する鍵レスのGitHub OIDC Artifact Attestation（SLSA v1 build provenance）も生成し、fail-closedなreference verifierで検証できます。これはproducer provenanceです（[#25](https://github.com/xhnagata/rigor/issues/25)）。SLSA Build Levelは主張せず、artifactの傍らに置かれたmanifestやchecksumは証明になりません。consumer enforcement（[#26](https://github.com/xhnagata/rigor/issues/26)）は、verified-install/managed-promotion wrapperである[`scripts/install-verified.mjs`](scripts/install-verified.mjs)として実装済みです。consumerがplugin外部から自身が保持するpolicyとともに独立に実行すると、attestationに対して検証済みのbytesのみがread-onlyのlocal seedへpromoteされ、`claude --plugin-dir <seed>`で起動されます。v0.15.0では、Node/zlibのversionに依存しない非圧縮tarを比較し、seed全体に存在する余分なfile、directory、symlink、非regular node、想定外の実行bitを厳密に拒否します。また、差し替え可能なdisk上のpathを再度開くのではなく、検証済みのin-memory archive bytesを展開します。portabilityと負例のintegration pathはconsumer Node 20、24、26で実行されます。これはそのconsumerのみを保護します。通常のmarketplace installには実行前にcache済みbytesを検証する確認済みのpre-activation verifierが依然として存在せず（Claude Code 2.1.207で不在を確認済み）、管理されていないinstallはguaranteeの対象外のままです。詳細は[v0.15.0 release notes](https://github.com/xhnagata/rigor/releases/tag/v0.15.0)と[provenanceと検証](docs/provenance.md)を参照してください。

## セキュリティ前提と既知の限界

証跡はversion controlへ入るため、secretを含めてはいけません。Rigorはcheckの生出力を保存しませんが、利用者が入力した散文をsanitizeできません。intent、contract、escalationは必要最小限にしてください。悪意あるpolicyは悪意あるcommandを実行できるため、policy変更をCODEOWNERSとbase/head reviewで保護してください。

[MVP limitations](docs/mvp-limitations.md) に意図的な未実装とGitHub Issueを記録しています。Windows launcher、意味的なtest品質解析、GitHub設定の書き込みは依然として保証範囲外です。`rigor governance` はGitHub側設定を読み取り専用で検証しますが、変更はできません。producer provenanceとconsumer保有のverified-install wrapperは実装済みです（[provenanceと検証](docs/provenance.md)）が、通常のClaude Code marketplace経路や管理されていないinstallはそのguaranteeの対象外のままです。
