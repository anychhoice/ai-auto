# ai-auto

`ai-auto`는 OpenAI API와 Codex CLI를 함께 사용해서 로컬 프로젝트를 자동으로 개선하는 오케스트레이터입니다.

OpenAI API는 현재 프로젝트 상태를 읽고 “무엇을 고칠지” 토론하고 계획합니다. Codex CLI는 그 계획을 받아 실제 코드를 수정합니다. 이후 `ai-auto`가 테스트와 검증 명령을 실행하고, 실패하면 실패 로그를 다시 Codex에게 넘겨 수정하게 합니다.

기본 설정은 안전하게 잡혀 있습니다.

- 자동 배포는 꺼져 있습니다.
- 자동 커밋도 꺼져 있습니다.
- Codex는 `workspace-write` sandbox 안에서 실행됩니다.
- 모델이 임의로 제안한 테스트 명령은 기본적으로 실행하지 않습니다.
- 사람이 `config/ai-auto.json`에 적은 명령만 실행합니다.

## 전체 동작 흐름

```text
workspace 상태 읽기
→ OpenAI API가 토론하고 실행 계획 생성
→ Codex CLI가 코드 수정
→ 테스트 명령 실행
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
- 내부 토론 생성
- Codex에게 전달할 구현 프롬프트 작성
- 테스트와 검증 방향 제안
- 커밋 메시지 제안
- 배포 가능성 판단

### Codex CLI

[src/codex.js](./src/codex.js)가 `codex exec`를 실행합니다.

Codex CLI의 역할은 다음과 같습니다.

- 프로젝트 코드 읽기
- OpenAI API가 만든 계획에 따라 코드 수정
- 필요한 경우 테스트 추가 또는 수정
- 실패 로그를 바탕으로 재수정

### 오케스트레이터

[src/orchestrator.js](./src/orchestrator.js)가 전체 루프를 관리합니다.

오케스트레이터의 역할은 다음과 같습니다.

- workspace 상태 수집
- OpenAI API 계획 요청
- Codex 실행
- 테스트 실행
- 검증 실행
- 실패 시 재시도
- 로그 저장
- 선택적 커밋
- 선택적 배포
- 24시간 반복 실행

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
3. Codex CLI로 코드 수정을 시도합니다.
4. 테스트 명령을 실행합니다.
5. 검증 명령을 실행합니다.
6. 실패하면 설정된 횟수만큼 Codex에게 재수정을 요청합니다.
7. 결과 로그를 `.ai-auto/`에 저장합니다.

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

### commands.test

```json
{
  "commands": {
    "test": ["npm test"]
  }
}
```

Codex가 수정한 뒤 실행할 테스트 명령입니다.

프로젝트가 npm을 쓰지 않는다면 바꾸면 됩니다.

예시:

```json
{
  "commands": {
    "test": ["pnpm test"]
  }
}
```

또는 Python 프로젝트라면:

```json
{
  "commands": {
    "test": ["pytest"]
  }
}
```

### commands.verify

```json
{
  "commands": {
    "verify": ["npm run check"]
  }
}
```

테스트 외에 추가로 실행할 검증 명령입니다.

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

`false`이면 `config/ai-auto.json`에 사람이 적은 `commands.test`, `commands.verify`만 실행합니다.

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

### mission

```json
{
  "mission": "Continuously improve the current workspace project..."
}
```

AI에게 주는 장기 목표입니다.

예시:

```json
{
  "mission": "사용자가 업로드한 이미지에서 상품명을 추출하는 Next.js 앱을 안정적으로 개선한다. 테스트 없는 큰 변경보다 작은 개선과 회귀 테스트를 우선한다."
}
```

## 로그

실행 로그는 기본적으로 `.ai-auto/` 폴더에 저장됩니다.

각 cycle마다 JSON 로그가 생성됩니다.

로그에는 다음 정보가 들어갑니다.

- 시작 시간
- OpenAI API가 만든 계획
- Codex 실행 결과
- 테스트 결과
- 검증 결과
- 실패 요약
- 커밋 결과
- 배포 결과

문제가 생기면 `.ai-auto/` 안의 최신 로그를 보면 어떤 단계에서 실패했는지 확인할 수 있습니다.

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

설정된 시간 동안 반복 실행합니다. 기본 예시는 24시간입니다.

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
3. `commands.test`를 그 프로젝트에 맞게 수정합니다.
4. `commands.verify`를 그 프로젝트에 맞게 수정합니다.
5. `deploy.enabled`는 `false`로 둡니다.
6. `autoCommit`도 `false`로 둡니다.
7. `npm run doctor`로 환경을 확인합니다.
8. `npm run once`로 한 cycle만 돌립니다.
9. Git diff와 `.ai-auto/` 로그를 확인합니다.
10. 안정적이면 `npm run run`으로 장시간 실행합니다.

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
- 테스트 명령은 프로젝트마다 직접 설정해야 합니다.
- 배포 명령도 프로젝트마다 직접 설정해야 합니다.
- 무인 실행 중 네트워크, 권한, 패키지 설치 문제는 각 프로젝트 환경에 따라 실패할 수 있습니다.

## 빠른 예시

Next.js 프로젝트를 `../my-next-app`에서 관리한다고 가정하면:

```json
{
  "workspace": "../my-next-app",
  "commands": {
    "test": ["npm test"],
    "verify": ["npm run lint", "npm run build"],
    "status": ["git status --short"]
  },
  "autoCommit": false,
  "deploy": {
    "enabled": false,
    "command": "",
    "requireCleanGit": true
  },
  "mission": "Next.js 앱의 버그를 줄이고 테스트 가능한 작은 개선을 지속적으로 수행한다."
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
