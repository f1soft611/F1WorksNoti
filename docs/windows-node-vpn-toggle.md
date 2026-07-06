# Windows Node VPN Toggle Test

이 문서는 Linux bash(openfortivpn) 토글 검증 스크립트를 Windows + Node.js 환경에서 대체 실행하는 방법을 설명합니다.

## 1) 환경 변수 설정

`.env`에 아래 값을 추가합니다.

```env
FORTI_VPN_CLI_PATH=C:\Program Files\Fortinet\FortiClient\FortiClient.exe
FORTI_VPN_GUI_PATH=C:\Program Files\Fortinet\FortiClient\FortiGui.exe
VPN_TOGGLE_CONNECT_TIMEOUT_MS=45000

# 형식: name|gateway|username|password|url;name2|gateway|username|password|url2
VPN_TOGGLE_TARGETS=한국카본|211.54.142.1:10443|BxThmkim|hmkim1749|http://dps.hcarbon.com/;아이팩|211.217.99.17:10443|dj001|001|http://192.168.20.5:8080/
```

## 2) 실행

```powershell
npm run vpn:toggle-test
```

## 3) 판정 규칙

- PASS: 접속전 불가 AND 접속후 가능 AND 해제후 불가 AND disconnect 상태
- WARN: 접속후 가능하지만 접속전에도 가능 (대상이 사내 전용이 아닐 수 있음)
- FAIL: 접속후 불가이거나 해제 상태가 비정상

## 4) 출력 예시

```text
[한국카본] Result: PASS - VPN toggle works as expected.
[아이팩] Result: WARN - Target is reachable even without VPN. Baseline may be polluted.
```

## 참고

- FortiClient 버전에 따라 CLI 자동 연결 인자 지원이 다를 수 있습니다.
- `VPN_SAML_REQUIRED` 또는 `VPN_CLI_UNSUPPORTED`가 출력되면, GUI 기반 로그인 후 재실행이 필요할 수 있습니다.
