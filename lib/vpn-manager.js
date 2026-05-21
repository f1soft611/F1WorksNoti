import { spawn } from 'child_process';

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
