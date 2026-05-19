# ai-auto

`ai-auto`는 OpenAI API와 Codex CLI를 함께 사용해서 로컬 프로젝트를 자동으로 개선하는 오케스트레이터입니다.

OpenAI API는 현재 프로젝트 상태를 읽고 “무엇을 고칠지” 토론하고 계획합니다. 계획 전에는 OpenAI가 Codex에게 물어볼 read-only 질문을 만들고, `ai-auto`가 그 질문으로 Codex CLI를 호출합니다. OpenAI는 Codex의 답변까지 보고 최종 계획을 만들고, Codex CLI는 그 계획을 받아 실제 코드를 수정합니다.

기본 설정은 안전하게 잡혀 있습니다.

- 자동 배포는 꺼져 있습니다.
- 자동 커밋도 꺼져 있습니다.
- Codex는 `workspace-write` sandbox 안에서 실행됩니다.
- 계획 전 Codex 상담은 `read-only` sandbox에서 실행됩니다.
- 테스트/검증 명령은 프로젝트 파일을 보고 자동 탐지합니다.
- 테스트가 없으면 그냥 통과시키지 않고 Codex에게 테스트 셋업부터 만들게 합니다.
- 모델이 임의로 제안한 테스트 명령은 기본적으로 실행하지 않습니다.

## 전체 동작 흐름

```text
workspace 상태 읽기
→ 추가 자연어 지시가 있으면 함께 읽기
→ OpenAI가 Codex에게 물어볼 read-only 질문 생성
→ Codex CLI에게 read-only로 프로젝트 구조와 테스트 전략 질문
→ OpenAI API가 Codex 답변까지 보고 실행 계획 생성
→ Codex CLI가 코드 수정
→ 테스트/검증 명령 자동 탐지
→ 테스트가 없으면 Codex에게 테스트 작성 요청
→ 탐지된 테스트 명령 실행
→ 검증 명령 실행
→ 실패하면 Codex에게 실패 로그를 넘겨 재수정
→ 성공하면 로그 저장
→ 설정된 경우 커밋
→ 설정된 경우 배포
→ 다음 cycle까지 대기
```

## 구성 요소

### OpenAI API

[src/openai.js](./src/openai.js)가 OpenAI Responses API를 호출합니다.

OpenAI API의 역할은 다음과 같습니다.

- 현재 Git 상태 확인
- 파일 목록 확인
- `package.json` 확인
- 프로젝트의 목표 확인
- Codex에게 물어볼 read-only 질문 생성
- read-only Codex 상담 결과 확인
- 내부 토론 생성
- Codex에게 전달할 구현 프롬프트 작성
- 테스트와 검증 방향 제안
- 커밋 메시지 제안
- 배포 가능성 판단

### Codex CLI

[src/codex.js](./src/codex.js)가 `codex exec`를 실행합니다.

Codex CLI의 역할은 다음과 같습니다.

- OpenAI 계획 전 read-only 상담자로 프로젝트를 파악
- 프로젝트 코드 읽기
- OpenAI API가 만든 계획에 따라 코드 수정
- 필요한 경우 테스트 추가 또는 수정
- 실패 로그를 바탕으로 재수정

### 오케스트레이터

[src/orchestrator.js](./src/orchestrator.js)가 전체 루프를 관리합니다.

오케스트레이터의 역할은 다음과 같습니다.

- workspace 상태 수집
- 테스트/검증 명령 자동 탐지
- Codex read-only 상담 실행
- OpenAI API 계획 요청
- Codex 실행
- 테스트 실행
- 검증 실행
- 실패 시 재시도
- 로그 저장
- 선택적 커밋
- 선택적 배포
- 24시간 반복 실행
- 실행 중 추가된 자연어 지시 감지

## workspace란?

여기서 `workspace`는 “Codex가 개발할 대상 프로젝트 폴더”를 뜻합니다.

반드시 `workspace`라는 이름의 폴더를 만들어야 하는 것은 아닙니다. 이미 존재하는 프로젝트 경로를 지정해도 됩니다.

기본 예시 설정은 다음과 같습니다.

```json
{
  "workspace": "."
}
```

이 경우 현재 `ai-auto` 폴더 자체를 작업 대상 프로젝트로 봅니다.

실전에서는 보통 `ai-auto`와 실제 개발 대상 프로젝트를 분리하는 편이 더 깔끔합니다.

예시 1: `ai-auto` 폴더 안에 대상 프로젝트를 둘 때

```text
ai-auto/
  config/
  src/
  workspace/
    my-project/
```

설정:

```json
{
  "workspace": "./workspace/my-project"
}
```

예시 2: `ai-auto` 옆에 있는 다른 프로젝트를 관리할 때

```text
anychhoice/
  ai-auto/
  my-real-app/
```

설정:

```json
{
  "workspace": "../my-real-app"
}
```

## 설치 및 준비

먼저 예시 파일을 복사합니다.

```bash
cp .env.example .env
cp config/ai-auto.example.json config/ai-auto.json
```

`.env`에 OpenAI API 키를 넣습니다.

```bash
OPENAI_API_KEY=sk-your-key-here
```

또는 셸에서 직접 export해도 됩니다.

```bash
export OPENAI_API_KEY="sk-..."
```

환경을 확인합니다.

```bash
npm run doctor
```

`doctor`는 다음을 확인합니다.

- `OPENAI_API_KEY` 존재 여부
- Codex CLI 설치 여부
- Git workspace 상태
- 설정 파일 해석 결과

## 한 번만 실행하기

한 cycle만 실행하려면 다음 명령을 사용합니다.

```bash
npm run once
```

한 cycle은 다음 작업을 수행합니다.

1. workspace 상태를 읽습니다.
2. OpenAI API로 실행 계획을 만듭니다.
3. Codex CLI에게 read-only로 프로젝트를 먼저 물어봅니다.
4. Codex 답변을 OpenAI 계획 입력에 포함합니다.
5. Codex CLI로 코드 수정을 시도합니다.
6. 테스트/검증 명령을 자동 탐지합니다.
7. 테스트가 없으면 Codex에게 테스트 셋업을 먼저 만들게 합니다.
8. 테스트와 검증 명령을 실행합니다.
9. 실패하면 설정된 횟수만큼 Codex에게 재수정을 요청합니다.
10. 결과 로그를 `.ai-auto/`에 저장합니다.

## 24시간 실행하기

장시간 루프를 실행하려면 다음 명령을 사용합니다.

```bash
npm run run
```

기본 예시 설정에서는 `maxRuntime`이 `24h`입니다.

```json
{
  "maxRuntime": "24h",
  "cycleInterval": "30m"
}
```

이 설정은 24시간 동안 실행하되, 각 cycle 사이에 30분씩 대기한다는 뜻입니다.

실행 중 자연어 지시가 추가되면 30분을 모두 기다리지 않고 다음 cycle을 시작합니다.

## 실행 중 자연어로 지시하기

`npm run run`으로 장시간 루프가 도는 중에도 자연어 지시를 추가할 수 있습니다.

같은 터미널에서는 그냥 문장을 입력하고 Enter를 누르면 됩니다.

```text
[instruction] 프로젝트 구조와 작동 방식을 먼저 파악해.
[instruction] 악보 생성 worker가 job을 가져간 이후 흐름을 명확히 질문해.
```

같은 터미널에서 사용할 수 있는 짧은 명령도 있습니다.

```text
/show
/clear
/help
```

다른 터미널에서 추가할 수도 있습니다.

```bash
npm run instruct -- "로그인 오류를 먼저 확인하고, UI 디자인 변경은 하지 마."
```

파이프로도 넣을 수 있습니다.

```bash
echo "이번에는 테스트 보강을 우선해." | npm run instruct
```

추가된 지시는 `.ai-auto/instructions.md`에 저장됩니다. 실행 중인 루프는 이 파일의 변경을 감지하고 다음 cycle을 앞당깁니다.

현재 활성 지시를 확인하려면:

```bash
npm run instructions
```

활성 지시를 비우려면:

```bash
npm run clear-instructions
```

`clear-instructions`는 지시 파일을 삭제하지 않고 archive 파일로 옮깁니다.

주의할 점이 하나 있습니다. 이미 실행 중인 `codex exec` 프로세스 내부에 실시간으로 메시지를 꽂아 넣는 것은 아닙니다. 대신 현재 Codex 작업이 끝난 뒤 다음 계획, 다음 수정 시도, 다음 cycle에 자연스럽게 반영됩니다.

## 텔레그램 보고와 `/whatnow`

Telegram Bot API를 사용해서 cycle 종료 결과를 텔레그램으로 받을 수 있습니다. 기본값은 꺼져 있습니다.

`.env`에 봇 토큰과 채팅 ID를 넣습니다.

```bash
TELEGRAM_BOT_TOKEN=123456:your-bot-token
TELEGRAM_CHAT_ID=123456789
```

`config/ai-auto.json`에서 텔레그램 보고를 켭니다.

```json
{
  "telegram": {
    "enabled": true,
    "reportCycles": true,
    "commands": {
      "enabled": false
    }
  }
}
```

이렇게 하면 `npm run run`이 각 cycle을 끝낼 때 텔레그램으로 짧은 결과를 보냅니다.

텔레그램에서 `/whatnow`를 호출하려면 command polling도 켭니다.

```json
{
  "telegram": {
    "enabled": true,
    "commands": {
      "enabled": true,
      "allowedChatIds": []
    }
  }
}
```

이제 `npm run run` 하나를 실행하면 runner cycle과 Telegram command polling이 같은 프로세스 안에서 함께 동작합니다.

```bash
npm run run
```

이후 봇에게 다음 메시지를 보내면 현재 누적 실행 결과를 한글로 답장합니다.

```text
/whatnow
```

`allowedChatIds`가 비어 있으면 `TELEGRAM_CHAT_ID` 또는 `telegram.chatId`만 허용됩니다. 여러 채팅에서 쓰려면 허용할 chat id를 배열에 넣습니다.

`npm run telegram`은 runner 없이 Telegram 명령만 따로 받을 때 쓰는 standalone 명령입니다. 보통은 `npm run run` 하나만 켜면 됩니다.

## 주요 설정

설정 파일은 `config/ai-auto.json`입니다. 처음에는 `config/ai-auto.example.json`을 복사해서 만듭니다.

### workspace

```json
{
  "workspace": "."
}
```

Codex가 수정할 프로젝트 경로입니다.

### model

```json
{
  "model": "gpt-5.5"
}
```

OpenAI API가 토론과 계획 생성에 사용할 모델입니다.

### reasoningEffort

```json
{
  "reasoningEffort": "high"
}
```

계획 생성 시 reasoning 강도를 지정합니다.

### maxRuntime

```json
{
  "maxRuntime": "24h"
}
```

전체 루프를 얼마나 오래 실행할지 정합니다.

지원 형식:

- `500ms`
- `10s`
- `30m`
- `24h`
- `2d`

### cycleInterval

```json
{
  "cycleInterval": "30m"
}
```

각 cycle 사이의 대기 시간입니다.

### maxIterationsPerCycle

```json
{
  "maxIterationsPerCycle": 3
}
```

한 cycle 안에서 Codex가 실패를 고치기 위해 재시도할 수 있는 최대 횟수입니다.

예를 들어 테스트가 실패하면 실패 로그를 Codex에게 다시 넘기고, 최대 3번까지 수정하게 합니다.

### instructionFile

```json
{
  "instructionFile": ".ai-auto/instructions.md"
}
```

실행 중 추가한 자연어 지시가 저장되는 파일입니다.

상대 경로로 쓰면 `workspace` 기준으로 해석됩니다.

보통 직접 편집하지 않고 다음 명령으로 추가합니다.

```bash
npm run instruct -- "이번 cycle에서는 테스트 보강을 우선해."
```

### commandDiscovery

```json
{
  "commandDiscovery": {
    "enabled": true,
    "requireTests": true,
    "fallbackVerifyCommands": ["git diff --check"]
  }
}
```

프로젝트의 테스트/검증 명령을 자동 탐지하는 설정입니다.

현재 자동 탐지하는 대표 패턴은 다음과 같습니다.

- Node: `package.json`의 `test`, `check`, `lint`, `typecheck`, `build` 등
- Python: `pytest`, `compileall`
- Rust: `cargo test`, `cargo check`
- Go: `go test ./...`, `go vet ./...`
- Java: Maven/Gradle test
- Elixir/Ruby 일부 기본 패턴

`requireTests`가 `true`이면 runnable test command가 없을 때 cycle을 성공 처리하지 않습니다. 이 경우 Codex에게 먼저 최소 테스트 셋업과 테스트 명령을 만들게 합니다.

`fallbackVerifyCommands`는 테스트가 있든 없든 마지막에 추가로 실행하는 안전 검증입니다. 기본값은 whitespace 문제를 잡는 `git diff --check`입니다.

### codexConsultation

```json
{
  "codexConsultation": {
    "enabled": true,
    "questionSource": "openai",
    "sandbox": "read-only",
    "approvalPolicy": "never",
    "timeoutMs": 1200000
  }
}
```

OpenAI가 계획하기 전에 Codex CLI에게 프로젝트를 먼저 물어보는 단계입니다.

기본값인 `questionSource: "openai"`에서는 OpenAI가 먼저 “Codex에게 무엇을 물어볼지” 질문을 생성합니다. 그 질문을 `ai-auto`가 Codex CLI에 전달하고, Codex 답변을 다시 OpenAI 최종 계획 입력에 넣습니다.

Codex 상담 단계는 read-only sandbox에서 실행됩니다. 이 단계는 파일을 수정하지 않고 다음 내용을 OpenAI에게 넘깁니다.

- 프로젝트 구조 이해
- 사용자에게 물어봐야 할 질문
- 기존 테스트/검증 구조
- 테스트가 없을 때 추가해야 할 최소 테스트 셋업
- 안전하게 실행할 수 있는 명령 후보
- 먼저 할 만한 작은 개선점

### commands.test

```json
{
  "commands": {
    "test": []
  }
}
```

Codex가 수정한 뒤 실행할 테스트 명령을 사람이 직접 고정하고 싶을 때만 사용합니다.

기본값은 빈 배열입니다. 빈 배열이면 `ai-auto`가 프로젝트를 보고 자동 탐지합니다.

예시:

```json
{
  "commands": {
    "test": ["npm test"]
  }
}
```

### commands.verify

```json
{
  "commands": {
    "verify": []
  }
}
```

테스트 외에 추가로 실행할 검증 명령을 사람이 직접 고정하고 싶을 때만 사용합니다.

기본값은 빈 배열입니다. 빈 배열이면 `ai-auto`가 `lint`, `typecheck`, `build`, `cargo check`, `go vet` 같은 명령을 자동 탐지합니다.

예시:

```json
{
  "commands": {
    "verify": ["npm run lint", "npm run typecheck"]
  }
}
```

### allowPlannerCommandOverride

```json
{
  "allowPlannerCommandOverride": false
}
```

OpenAI API가 계획을 만들면서 테스트 명령을 제안할 수 있습니다. 하지만 기본값에서는 그 명령을 그대로 실행하지 않습니다.

`false`이면 OpenAI가 제안한 명령은 참고만 하고, 실제 실행은 자동 탐지된 명령과 config에 명시된 명령만 사용합니다.

`true`로 바꾸면 모델이 제안한 명령을 실행할 수 있습니다. 이 옵션은 신뢰할 수 있는 sandbox 환경에서만 켜는 것을 권장합니다.

### codex

```json
{
  "codex": {
    "command": "codex",
    "model": "gpt-5.5",
    "sandbox": "workspace-write",
    "approvalPolicy": "never"
  }
}
```

Codex CLI 실행 방식을 설정합니다.

- `command`: 실행할 Codex 명령
- `model`: Codex가 사용할 모델
- `sandbox`: Codex 실행 sandbox
- `approvalPolicy`: 승인 정책

기본값인 `approvalPolicy: "never"`는 무인 실행 중에 Codex가 사용자 승인을 기다리지 않도록 합니다. 승인 없이는 실패하게 만들기 때문에 자동화 루프가 멈춰서 입력을 기다리는 상황을 줄입니다.

### autoCommit

```json
{
  "autoCommit": false
}
```

검증이 통과한 뒤 자동으로 Git commit을 만들지 여부입니다.

기본값은 `false`입니다. 처음에는 사람이 변경사항을 직접 확인하는 것을 권장합니다.

자동 커밋을 켜면 OpenAI API가 제안한 커밋 메시지로 다음 명령을 실행합니다.

```bash
git add -A
git commit -m "..."
```

### deploy

```json
{
  "deploy": {
    "enabled": false,
    "command": "",
    "requireCleanGit": true
  }
}
```

배포 설정입니다.

기본값에서는 배포하지 않습니다.

배포를 켜려면 직접 명령을 설정해야 합니다.

```json
{
  "deploy": {
    "enabled": true,
    "command": "npm run deploy",
    "requireCleanGit": true
  }
}
```

`requireCleanGit`가 `true`이면 Git working tree가 깨끗할 때만 배포합니다.

자동 커밋 없이 배포하고 싶다면 `requireCleanGit` 때문에 배포가 건너뛰어질 수 있습니다. 이 경우 다음 중 하나를 선택해야 합니다.

- 사람이 직접 변경사항을 확인하고 커밋한 뒤 배포
- `autoCommit`을 `true`로 설정
- `requireCleanGit`를 `false`로 설정

운영 환경에서는 `requireCleanGit: true`를 유지하는 것을 권장합니다.

### telegram

```json
{
  "telegram": {
    "enabled": false,
    "botTokenEnv": "TELEGRAM_BOT_TOKEN",
    "chatIdEnv": "TELEGRAM_CHAT_ID",
    "chatId": "",
    "reportCycles": true,
    "commands": {
      "enabled": false,
      "allowedChatIds": [],
      "pollTimeoutSeconds": 25,
      "stateFile": ".ai-auto/telegram-offset.json"
    }
  }
}
```

Telegram 연동 설정입니다.

- `enabled`: 텔레그램 기능 전체 on/off
- `botTokenEnv`: 봇 토큰을 읽을 환경변수 이름
- `chatIdEnv`: 기본 chat id를 읽을 환경변수 이름
- `chatId`: 환경변수 대신 직접 지정할 chat id
- `reportCycles`: cycle 종료 보고 여부
- `commands.enabled`: `/whatnow` long polling 사용 여부
- `commands.allowedChatIds`: 명령을 허용할 chat id 목록
- `commands.stateFile`: Telegram `getUpdates` offset 저장 파일

### mission

```json
{
  "mission": "First understand the target project, identify its architecture, tests, risks, and improvement opportunities..."
}
```

AI에게 주는 장기 목표입니다.

기본 mission은 처음부터 코드를 크게 바꾸라는 지시가 아닙니다. 먼저 대상 프로젝트를 파악하고, 구조와 테스트와 위험 지점을 살펴본 뒤, 작고 검증 가능한 개선점을 하나 선택하도록 되어 있습니다.

예시:

```json
{
  "mission": "먼저 Next.js 앱의 구조, 테스트, 빌드 흐름을 파악하고 개선점을 찾는다. 이후 테스트 가능한 작은 개선을 하나씩 수행한다."
}
```

## 로그

실행 로그는 기본적으로 `.ai-auto/` 폴더에 저장됩니다.

각 cycle마다 JSON 로그가 생성됩니다.

로그에는 다음 정보가 들어갑니다.

- 시작 시간
- Codex read-only 상담 결과
- OpenAI API가 만든 계획
- 자동 탐지된 테스트/검증 명령
- Codex 실행 결과
- 테스트 결과
- 검증 결과
- 실패 요약
- 커밋 결과
- 배포 결과

문제가 생기면 `.ai-auto/` 안의 최신 로그를 보면 어떤 단계에서 실패했는지 확인할 수 있습니다.

테스트가 없는 프로젝트에서 Codex가 테스트 셋업을 만들지 못하면 outcome이 `test_setup_missing`으로 남습니다. 이 경우 다음 cycle 또는 다음 재시도에서 Codex는 최소 테스트와 runnable test command를 먼저 만들도록 지시받습니다.

## 명령어 요약

```bash
npm run doctor
```

환경을 점검합니다.

```bash
npm run once
```

한 cycle만 실행합니다.

```bash
npm run run
```

설정된 시간 동안 반복 실행합니다. 기본 예시는 24시간입니다. `telegram.commands.enabled`가 true이면 같은 프로세스에서 Telegram `/whatnow` 명령도 함께 받습니다.

```bash
npm run telegram
```

runner 없이 Telegram `/whatnow` 명령만 standalone long polling으로 받습니다.

```bash
npm run what-now
```

현재 누적 실행 결과를 한글로 요약합니다.

```bash
npm run instruct -- "자연어 지시"
```

실행 중인 루프에 추가 지시를 남깁니다. 다음 계획이나 다음 cycle부터 반영됩니다.

```bash
npm run instructions
```

현재 활성 지시를 확인합니다.

```bash
npm run clear-instructions
```

활성 지시를 archive로 옮기고 비웁니다.

```bash
npm test
```

이 프로젝트 자체의 테스트를 실행합니다.

```bash
npm run check
```

이 프로젝트 자체의 문법 체크를 실행합니다.

## 처음 운영할 때 권장 순서

1. `config/ai-auto.json`을 만듭니다.
2. `workspace`를 실제 개발 대상 프로젝트로 지정합니다.
3. 테스트 명령은 일단 비워 둡니다. `ai-auto`가 자동 탐지합니다.
4. `deploy.enabled`는 `false`로 둡니다.
5. `autoCommit`도 `false`로 둡니다.
6. `npm run doctor`로 환경을 확인합니다.
7. `npm run once`로 한 cycle만 돌립니다.
8. Git diff와 `.ai-auto/` 로그를 확인합니다.
9. 안정적이면 `npm run run`으로 장시간 실행합니다.
10. 실행 중 방향을 바꾸고 싶으면 `npm run instruct -- "..."`로 자연어 지시를 추가합니다.

## 주의사항

이 프로젝트는 자동으로 코드를 수정할 수 있습니다. 처음부터 운영 배포까지 완전 자동으로 연결하지 말고, 작은 프로젝트나 별도 브랜치에서 먼저 검증하는 것을 권장합니다.

특히 다음 설정은 신중하게 켜야 합니다.

- `autoCommit: true`
- `deploy.enabled: true`
- `allowPlannerCommandOverride: true`
- `deploy.requireCleanGit: false`

## 현재 제한

- OpenAI API 키가 필요합니다.
- Codex CLI가 로컬에 설치되어 있어야 합니다.
- 자동 탐지하지 못하는 특수한 프로젝트는 `commands.test`나 `commands.verify`를 직접 지정할 수 있습니다.
- 배포 명령도 프로젝트마다 직접 설정해야 합니다.
- 무인 실행 중 네트워크, 권한, 패키지 설치 문제는 각 프로젝트 환경에 따라 실패할 수 있습니다.

## 빠른 예시

Next.js 프로젝트를 `../my-next-app`에서 관리한다고 가정하면:

```json
{
  "workspace": "../my-next-app",
  "commands": {
    "test": [],
    "verify": [],
    "status": ["git status --short"]
  },
  "commandDiscovery": {
    "enabled": true,
    "requireTests": true,
    "fallbackVerifyCommands": ["git diff --check"]
  },
  "codexConsultation": {
    "enabled": true,
    "questionSource": "openai",
    "sandbox": "read-only",
    "approvalPolicy": "never",
    "timeoutMs": 1200000
  },
  "autoCommit": false,
  "deploy": {
    "enabled": false,
    "command": "",
    "requireCleanGit": true
  },
  "mission": "먼저 Next.js 앱의 구조, 테스트, 빌드 흐름을 파악하고 개선점을 찾는다. 이후 테스트 가능한 작은 개선을 하나씩 수행한다."
}
```

이후:

```bash
npm run doctor
npm run once
```

결과가 괜찮으면:

```bash
npm run run
```
