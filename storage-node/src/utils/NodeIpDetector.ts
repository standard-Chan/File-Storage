import os from 'os';

/**
 * 현재 Node IP를 감지하는 유틸리티
 */
export class NodeIpDetector {
  /**
   * 현재 노드의 IP 주소 반환
   * 1. 환경변수 NODE_IP 확인
   * 2. 네트워크 인터페이스에서 IPv4 주소 추출
   * 3. localhost 반환 (기본값)
   */
  static getCurrentNodeIp(): string {
    // 1. 환경변수 확인
    const envNodeIp = process.env.NODE_IP;
    if (envNodeIp && envNodeIp.trim() !== '') {
      return envNodeIp.trim();
    }

    // 2. 네트워크 인터페이스에서 IPv4 주소 추출
    const networkInterfaces = os.networkInterfaces();
    for (const interfaceName of Object.keys(networkInterfaces)) {
      const interfaces = networkInterfaces[interfaceName];
      if (!interfaces) continue;

      for (const iface of interfaces) {
        // IPv4 주소만 필터링
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }

    // 3. 기본값 반환
    console.warn('Failed to detect node IP, using localhost');
    return '127.0.0.1';
  }
}
