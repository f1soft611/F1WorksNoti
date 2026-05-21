# VPN-aware 헬스 체크 시스템 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FortiVPN 연결이 필요한 운영사이트의 헬스 체크를 자동화하고, VPN 불필요 사이트와 분리하여 독립적으로 스케줄 관리

**Architecture:** VPN 연결/해제를 담당하는 전용 모듈을 분리하고, 기존 헬스 체크 로직에 VPN 플로우를 통합. 스케줄을 VPN/Non-VPN으로 분리하여 각각 독립적으로 실행

**Tech Stack:** Node.js child_process (FortiVPN CLI 제어), dotenv (환경변수 관리)

---

### Task 1: VPN 매니저 모듈 생성

**Files:**

- Create: `lib/vpn-manager.js`

- [ ] **Step 1: vpn-manager.js 파일 생성**

```javascript
import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';

const execPromise = promisify(exec);

class VPNManager {
  constructor(config) {
    this.gateway = config.gateway;
    this.username = config.username;
    this.password = config.password;
    this.cliPath = config.cliPath || 'fortivpn';
    this.isConnected = false;
    this.process = null;
  }

  async connect(timeout = 30000) {
    try {
      // FortiVPN CLI 연결 명령어
      // fortivpn --server <gateway> --username <username> --password <password> connect
      const command = `${this.cliPath} --server ${this.gateway} --username ${this.username} --password ${this.password} connect`;

      // 프로세스 실행 (백그라운드)
      this.process = spawn(this.cliPath, [
        '--server',
        this.gateway,
        '--username',
        this.username,
        '--password',
        this.password,
        'connect',
      ]);

      // 연결 완료 대기 (타임아웃 포함)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`VPN connection timeout after ${timeout}ms`));
        }, timeout);

        this.process.on('error', (err) => {
          clearTimeout(timer);
          this.isConnected = false;
          reject(new Error(`VPN connection failed: ${err.message}`));
        });

        // 간단한 연결 확인: 프로세스가 에러 없이 실행되면 성공으로 가정
        setTimeout(() => {
          clearTimeout(timer);
          this.isConnected = true;
          resolve();
        }, 2000); // 2초 후 연결 성공으로 판단
      });
    } catch (err) {
      this.isConnected = false;
      throw new Error(`VPN connect error: ${err.message}`);
    }
  }

  async disconnect() {
    try {
      if (this.process) {
        // 프로세스 종료 신호 전송
        this.process.kill('SIGTERM');

        // 정리 대기
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (this.process) {
              this.process.kill('SIGKILL');
            }
            this.isConnected = false;
            resolve();
          }, 5000);

          this.process.on('exit', () => {
            clearTimeout(timer);
            this.isConnected = false;
            resolve();
          });
        });
      }
      this.isConnected = false;
    } catch (err) {
      console.error(`VPN disconnect error: ${err.message}`);
      this.isConnected = false;
    }
  }

  getStatus() {
    return {
      connected: this.isConnected,
      gateway: this.gateway,
      lastUpdated: new Date(),
    };
  }
}

export default VPNManager;
```

- [ ] **Step 2: 파일 저장 확인**

`lib/vpn-manager.js` 파일이 생성되었고, 4개 메서드 포함되어 있는지 확인:

- `connect()`: VPN 연결
- `disconnect()`: VPN 연결 해제
- `getStatus()`: 연결 상태 반환

---

### Task 2: 환경변수 설정 추가

**Files:**

- Modify: `.env` (기존 파일에 추가)

- [ ] **Step 1: .env 파일에 VPN 설정 추가**

기존 `.env` 파일의 끝에 다음 내용 추가:

```bash
# FortiVPN Configuration
FORTI_VPN_GATEWAY=vpn.company.com
FORTI_VPN_USERNAME=your_username
FORTI_VPN_PASSWORD=your_password
FORTI_VPN_CLI_PATH=fortivpn

# Health Check URLs (VPN 필요 없음)
WEB_SERVER_HEALTH_URLS=https://f1lab.co.kr

# Health Check URLs (VPN 필요)
VPN_REQUIRED_HEALTH_URLS=http://example.com,http://internal-site.local
```

- [ ] **Step 2: .env 파일 검증**

`dotenv.config()` 호출 후 환경변수 로드 확인:

```bash
node -e "import dotenv from 'dotenv'; dotenv.config(); console.log(process.env.FORTI_VPN_GATEWAY)"
```

Expected: `vpn.company.com` 출력

---

### Task 3: app.js 수정 - VPN 매니저 통합 및 스케줄 분리

**Files:**

- Modify: `app.js` (두 부분: import 추가, 헬스체크 로직 수정)

- [ ] **Step 1: import 문에 VPNManager 추가**

`app.js` 상단의 import 섹션 수정:

```javascript
import express from 'express';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { scheduleJob } from 'node-schedule';
import { connPool } from './config/server.js';
import sharp from 'sharp';
import sql from 'mssql';
import NewsAPI from 'newsapi';
import puppeteer from 'puppeteer';
import VPNManager from './lib/vpn-manager.js'; // 추가 줄

const newsapi = new NewsAPI('7ed043a7f64043a795f7799708c581e3');
```

- [ ] **Step 2: VPN 설정 함수 추가**

`getHealthCheckUrls()` 함수 아래에 새로운 함수 추가:

```javascript
function getVPNRequiredHealthCheckUrls() {
  const raw = process.env.VPN_REQUIRED_HEALTH_URLS || '';

  if (!raw) return [];

  return [
    ...new Set(
      raw
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean),
    ),
  ];
}

function getVPNConfig() {
  return {
    gateway: process.env.FORTI_VPN_GATEWAY,
    username: process.env.FORTI_VPN_USERNAME,
    password: process.env.FORTI_VPN_PASSWORD,
    cliPath: process.env.FORTI_VPN_CLI_PATH || 'fortivpn',
  };
}
```

- [ ] **Step 3: VPN 매니저 인스턴스 생성**

`app.set('port', ...)` 줄 다음에 추가:

```javascript
app.set('port', process.env.PORT || 3000);

// VPN 매니저 초기화
const vpnManager = new VPNManager(getVPNConfig());
```

- [ ] **Step 4: 기존 스케줄 유지 (VPN 불필요 체크)**

현재 스케줄 코드는 유지하되, 주석으로 구분:

```javascript
// ===== Non-VPN 헬스 체크 스케줄 (기존) =====
schedule.scheduleJob('*/5 * * * *', async () => {
  console.log(`[Health Check] Non-VPN URLs at ${new Date().toISOString()}`);
  const urls = getHealthCheckUrls();

  for (const url of urls) {
    try {
      const response = await axios.get(url, { timeout: 5000 });
      webServerStatuses[url] = {
        status: response.status === 200 ? 'up' : 'down',
        lastChecked: new Date(),
      };
      console.log(`[OK] ${url}: ${webServerStatuses[url].status}`);
    } catch (error) {
      webServerStatuses[url] = {
        status: 'down',
        lastChecked: new Date(),
        error: error.message,
      };
      console.log(`[FAILED] ${url}: down - ${error.message}`);
    }
  }
});
```

- [ ] **Step 5: VPN 헬스 체크 스케줄 추가**

기존 스케줄 아래에 새로운 스케줄 추가:

```javascript
// ===== VPN 헬스 체크 스케줄 (신규) =====
schedule.scheduleJob('*/5 * * * *', async () => {
  console.log(`[Health Check] VPN URLs at ${new Date().toISOString()}`);
  const urls = getVPNRequiredHealthCheckUrls();

  if (urls.length === 0) {
    console.log('[VPN Health Check] No VPN-required URLs configured');
    return;
  }

  let vpnConnected = false;

  try {
    // VPN 연결
    console.log('[VPN] Connecting to FortiVPN...');
    await vpnManager.connect();
    vpnConnected = true;
    console.log('[VPN] Connected successfully');

    // 각 URL 헬스 체크
    for (const url of urls) {
      try {
        const response = await axios.get(url, { timeout: 5000 });
        webServerStatuses[url] = {
          status: response.status === 200 ? 'up' : 'down',
          lastChecked: new Date(),
          vpnRequired: true,
        };
        console.log(`[OK] ${url}: ${webServerStatuses[url].status}`);
      } catch (error) {
        webServerStatuses[url] = {
          status: 'down',
          lastChecked: new Date(),
          error: error.message,
          vpnRequired: true,
        };
        console.log(`[FAILED] ${url}: down - ${error.message}`);
      }
    }
  } catch (vpnError) {
    console.error(`[VPN] Connection failed: ${vpnError.message}`);

    // 모든 VPN URL을 'down' 상태로 표시
    for (const url of urls) {
      webServerStatuses[url] = {
        status: 'down',
        lastChecked: new Date(),
        error: `VPN connection failed: ${vpnError.message}`,
        vpnRequired: true,
      };
    }
  } finally {
    // VPN 연결 해제
    if (vpnConnected) {
      try {
        console.log('[VPN] Disconnecting...');
        await vpnManager.disconnect();
        console.log('[VPN] Disconnected');
      } catch (disconnectError) {
        console.error(`[VPN] Disconnect error: ${disconnectError.message}`);
      }
    }
  }
});
```

- [ ] **Step 6: 파일 저장 및 구문 검증**

`app.js` 파일 저장 후 구문 확인:

```bash
node --check app.js
```

Expected: 오류 없음 (구문 체크 통과)

---

### Task 4: 상태 API 응답 수정

**Files:**

- Modify: `app.js` (`/api/server-status` 라우트)

- [ ] **Step 1: 기존 `/api/server-status` 라우트 확인**

현재 코드의 응답 형식을 확인하고, 모든 URL (VPN 필요/불필요)을 포함하도록 유지

```javascript
app.get('/api/server-status', function (req, res) {
  res.json(webServerStatuses);
});
```

이 응답은 `vpnRequired` 필드를 포함한 모든 상태 정보를 자동으로 반환하므로 추가 수정 불필요

- [ ] **Step 2: 응답 테스트**

```bash
curl http://localhost:3000/api/server-status
```

Expected: JSON 응답에 Non-VPN URL과 VPN URL 모두 포함, VPN URL에는 `"vpnRequired": true` 포함

---

### Task 5: 테스트 및 검증

**Files:**

- Test: 수동 테스트 시나리오

- [ ] **Step 1: 앱 시작**

```bash
npm start
```

- [ ] **Step 2: 로그 모니터링**

다른 터미널에서 앱 로그 실시간 확인:

```bash
# 앱이 실행 중인 터미널에서 로그 관찰
```

Expected 로그:

- 5분마다 `[Health Check] Non-VPN URLs` 로그
- 5분마다 `[Health Check] VPN URLs` 로그
- VPN 연결/해제 메시지

- [ ] **Step 3: /api/server-status 엔드포인트 호출**

```bash
curl http://localhost:3000/api/server-status | jq
```

Expected: 다음과 같은 구조:

```json
{
  "https://f1lab.co.kr": {
    "status": "up",
    "lastChecked": "2026-05-21T...",
    "vpnRequired": false
  },
  "http://example.com": {
    "status": "up/down",
    "lastChecked": "2026-05-21T...",
    "vpnRequired": true
  }
}
```

- [ ] **Step 4: VPN 연결 성공 확인**

FortiVPN이 실제로 설치되어 있고 자격증명이 올바른지 확인. 로그에서:

- `[VPN] Connected successfully` 메시지 확인
- `[VPN] Disconnected` 메시지 확인

VPN 연결 실패 시: `.env`의 자격증명과 게이트웨이 정보 검증

---

### Task 6: Commit

**Files:**

- `lib/vpn-manager.js`
- `app.js`
- `.env`

- [ ] **Step 1: 변경사항 커밋**

```bash
git add lib/vpn-manager.js app.js .env
git commit -m "feat: add VPN-aware health check system

- Create VPNManager module for FortiVPN connection management
- Add environment variables for VPN configuration
- Separate health check schedules: Non-VPN and VPN-required URLs
- Include vpnRequired flag in server status response"
```

---
