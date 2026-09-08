/**
 * aBogus encryption for Douyin
 * Ported from Python implementation
 * Uses SM3 (Chinese National Standard) hash
 */

const { sm3 } = require('sm-crypto');

const USERAGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class ABogus {
  static FILTER = /%([0-9A-F]{2})/g;
  static ARGUMENTS = [0, 1, 14];
  static UA_KEY = "\u0000\u0001\u000e";
  static END_STRING = "cus";
  static VERSION = [1, 0, 1, 5];
  static BROWSER = "1536|742|1536|864|0|0|0|0|1536|864|1536|864|1536|742|24|24|Win32";
  static REG = [
    1937774191, 1226093241, 388252375, 3666478592,
    2842636476, 372324522, 3817729613, 2969243214
  ];
  static STR = {
    s0: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
    s1: "Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=",
    s2: "Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=",
    s3: "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe",
    s4: "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe"
  };

  constructor(userAgent = USERAGENT, platform = null) {
    this.chunk = [];
    this.size = 0;
    this.reg = [...ABogus.REG];
    this.uaCode = this.generateUaCode(userAgent);
    this.browser = platform ? ABogus.generateBrowserInfo(platform) : ABogus.BROWSER;
    this.browserLen = this.browser.length;
    this.browserCode = ABogus.charCodeAt(this.browser);
  }

  static randomList(a = null, b = 170, c = 85, d = 0, e = 0, f = 0, g = 0) {
    const r = a !== null ? a : Math.random() * 10000;
    const v = [r, Math.floor(r) & 255, Math.floor(r) >> 8];
    v.push((v[1] & b) | d);
    v.push((v[1] & c) | e);
    v.push((v[2] & b) | f);
    v.push((v[2] & c) | g);
    return v.slice(-4);
  }

  static list1(randomNum = null, a = 170, b = 85, c = 45) {
    return this.randomList(randomNum, a, b, 1, 2, 5, c & a);
  }

  static list2(randomNum = null, a = 170, b = 85) {
    return this.randomList(randomNum, a, b, 1, 0, 0, 0);
  }

  static list3(randomNum = null, a = 170, b = 85) {
    return this.randomList(randomNum, a, b, 1, 0, 5, 0);
  }

  static fromCharCode(...args) {
    return args.map(code => String.fromCharCode(code)).join('');
  }

  static generateString1(randomNum1 = null, randomNum2 = null, randomNum3 = null) {
    return (
      this.fromCharCode(...this.list1(randomNum1)) +
      this.fromCharCode(...this.list2(randomNum2)) +
      this.fromCharCode(...this.list3(randomNum3))
    );
  }

  generateString2(urlParams, method = 'GET', startTime = 0, endTime = 0) {
    const a = this.generateString2List(urlParams, method, startTime, endTime);
    const e = ABogus.endCheckNum(a);
    a.push(...this.browserCode);
    a.push(e);
    return ABogus.rc4Encrypt(ABogus.fromCharCode(...a), 'y');
  }

  generateUaCode(userAgent) {
    const u = ABogus.rc4Encrypt(userAgent, ABogus.UA_KEY);
    const result = ABogus.generateResult(u, 's3');
    return this.sum(result);
  }

  generateString2List(urlParams, method = 'GET', startTime = 0, endTime = 0) {
    startTime = startTime || Date.now();
    endTime = endTime || (startTime + Math.floor(Math.random() * 5) + 4);

    const paramsArray = this.generateParamsCode(urlParams);
    const methodArray = this.generateMethodCode(method);

    return ABogus.list4(
      (endTime >> 24) & 255,
      paramsArray[21],
      this.uaCode[23],
      (endTime >> 16) & 255,
      paramsArray[22],
      this.uaCode[24],
      (endTime >> 8) & 255,
      (endTime >> 0) & 255,
      (startTime >> 24) & 255,
      (startTime >> 16) & 255,
      (startTime >> 8) & 255,
      (startTime >> 0) & 255,
      methodArray[21],
      methodArray[22],
      Math.floor(endTime / 256 / 256 / 256 / 256) >> 0,
      Math.floor(startTime / 256 / 256 / 256 / 256) >> 0,
      this.browserLen
    );
  }

  static list4(a, b, c, d, e, f, g, h, i, j, k, m, n, o, p, q, r) {
    return [
      44, a, 0, 0, 0, 0, 24, b, n, 0, c, d, 0, 0, 0, 1, 0, 239,
      e, o, f, g, 0, 0, 0, 0, h, 0, 0, 14, i, j, 0, k, m, 3, p, 1, q, 1, r, 0, 0, 0
    ];
  }

  static endCheckNum(a) {
    return a.reduce((r, i) => r ^ i, 0);
  }

  static regToArray(a) {
    const o = new Array(32).fill(0);
    for (let i = 0; i < 8; i++) {
      let c = a[i];
      o[4 * i + 3] = 255 & c;
      c >>= 8;
      o[4 * i + 2] = 255 & c;
      c >>= 8;
      o[4 * i + 1] = 255 & c;
      c >>= 8;
      o[4 * i] = 255 & c;
    }
    return o;
  }

  compress(a) {
    const f = this.generateF(a);
    const i = [...this.reg];

    for (let o = 0; o < 64; o++) {
      let c = this.de(i[0], 12) + i[4] + this.de(this.pe(o), o);
      c = c >>> 0;
      c = this.de(c, 7);
      const s = (c ^ this.de(i[0], 12)) >>> 0;

      let u = this.he(o, i[0], i[1], i[2]);
      u = (u + i[3] + s + f[o + 68]) >>> 0;

      let b = this.ve(o, i[4], i[5], i[6]);
      b = (b + i[7] + c + f[o]) >>> 0;

      i[3] = i[2];
      i[2] = this.de(i[1], 9);
      i[1] = i[0];
      i[0] = u;

      i[7] = i[6];
      i[6] = this.de(i[5], 19);
      i[5] = i[4];
      i[4] = (b ^ this.de(b, 9) ^ this.de(b, 17)) >>> 0;
    }

    for (let l = 0; l < 8; l++) {
      this.reg[l] = (this.reg[l] ^ i[l]) >>> 0;
    }
  }

  generateF(e) {
    const r = new Array(132).fill(0);

    for (let t = 0; t < 16; t++) {
      r[t] = (
        (e[4 * t] << 24) |
        (e[4 * t + 1] << 16) |
        (e[4 * t + 2] << 8) |
        e[4 * t + 3]
      ) >>> 0;
    }

    for (let n = 16; n < 68; n++) {
      let a = r[n - 16] ^ r[n - 9] ^ this.de(r[n - 3], 15);
      a = a ^ this.de(a, 15) ^ this.de(a, 23);
      r[n] = (a ^ this.de(r[n - 13], 7) ^ r[n - 6]) >>> 0;
    }

    for (let n = 68; n < 132; n++) {
      r[n] = (r[n - 68] ^ r[n - 64]) >>> 0;
    }

    return r;
  }

  static padArray(arr, length = 60) {
    while (arr.length < length) {
      arr.push(0);
    }
    return arr;
  }

  fill(length = 60) {
    const size = 8 * this.size;
    this.chunk.push(128);
    this.chunk = ABogus.padArray(this.chunk, length);
    for (let i = 0; i < 4; i++) {
      this.chunk.push((size >> (8 * (3 - i))) & 255);
    }
  }

  de(e, r) {
    r %= 32;
    return ((e << r) >>> 0) | (e >>> (32 - r));
  }

  pe(e) {
    return (0 <= e && e < 16) ? 2043430169 : 2055708042;
  }

  he(e, r, t, n) {
    if (0 <= e && e < 16) {
      return (r ^ t ^ n) >>> 0;
    } else if (16 <= e && e < 64) {
      return ((r & t) | (r & n) | (t & n)) >>> 0;
    }
    throw new Error('Invalid value');
  }

  ve(e, r, t, n) {
    if (0 <= e && e < 16) {
      return (r ^ t ^ n) >>> 0;
    } else if (16 <= e && e < 64) {
      return ((r & t) | (~r & n)) >>> 0;
    }
    throw new Error('Invalid value');
  }

  static charCodeAt(s) {
    return Array.from(s).map(char => char.charCodeAt(0));
  }

  static decodeString(urlString) {
    return urlString.replace(this.FILTER, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  static splitArray(arr, chunkSize = 64) {
    const result = [];
    for (let i = 0; i < arr.length; i += chunkSize) {
      result.push(arr.slice(i, i + chunkSize));
    }
    return result;
  }

  write(e) {
    this.size = e.length;
    if (typeof e === 'string') {
      e = ABogus.decodeString(e);
      e = ABogus.charCodeAt(e);
    }
    if (e.length <= 64) {
      this.chunk = e;
    } else {
      const chunks = ABogus.splitArray(e, 64);
      for (let i = 0; i < chunks.length - 1; i++) {
        this.compress(chunks[i]);
      }
      this.chunk = chunks[chunks.length - 1];
    }
  }

  reset() {
    this.chunk = [];
    this.size = 0;
    this.reg = [...ABogus.REG];
  }

  sum(e, length = 60) {
    this.reset();
    this.write(e);
    this.fill(length);
    this.compress(this.chunk);
    return ABogus.regToArray(this.reg);
  }

  static generateResult(s, e = 's4') {
    const r = [];
    for (let i = 0; i < s.length; i += 3) {
      let n;
      if (i + 2 < s.length) {
        n = (s.charCodeAt(i) << 16) | (s.charCodeAt(i + 1) << 8) | s.charCodeAt(i + 2);
      } else if (i + 1 < s.length) {
        n = (s.charCodeAt(i) << 16) | (s.charCodeAt(i + 1) << 8);
      } else {
        n = s.charCodeAt(i) << 16;
      }

      const pairs = [[18, 0xFC0000], [12, 0x03F000], [6, 0x0FC0], [0, 0x3F]];
      for (const [j, k] of pairs) {
        if (j === 6 && i + 1 >= s.length) break;
        if (j === 0 && i + 2 >= s.length) break;
        r.push(this.STR[e][(n & k) >> j]);
      }
    }

    const padding = (4 - (r.length % 4)) % 4;
    for (let i = 0; i < padding; i++) {
      r.push('=');
    }
    return r.join('');
  }

  static rc4Encrypt(plaintext, key) {
    const s = Array.from({ length: 256 }, (_, i) => i);
    let j = 0;

    for (let i = 0; i < 256; i++) {
      j = (j + s[i] + key.charCodeAt(i % key.length)) % 256;
      [s[i], s[j]] = [s[j], s[i]];
    }

    let i = 0;
    j = 0;
    const cipher = [];

    for (let k = 0; k < plaintext.length; k++) {
      i = (i + 1) % 256;
      j = (j + s[i]) % 256;
      [s[i], s[j]] = [s[j], s[i]];
      const t = (s[i] + s[j]) % 256;
      cipher.push(String.fromCharCode(s[t] ^ plaintext.charCodeAt(k)));
    }

    return cipher.join('');
  }

  static sm3ToArray(data) {
    let bytes;
    if (typeof data === 'string') {
      bytes = Buffer.from(data, 'utf-8');
    } else {
      bytes = Buffer.from(data);
    }

    const hash = sm3(bytes);
    const result = [];
    for (let i = 0; i < hash.length; i += 2) {
      result.push(parseInt(hash.substr(i, 2), 16));
    }
    return result;
  }

  generateMethodCode(method = 'GET') {
    return ABogus.sm3ToArray(ABogus.sm3ToArray(method + ABogus.END_STRING));
  }

  generateParamsCode(params) {
    return ABogus.sm3ToArray(ABogus.sm3ToArray(params + ABogus.END_STRING));
  }

  static generateBrowserInfo(platform = 'Win32') {
    const innerWidth = 1536;
    const innerHeight = 742;
    const outerWidth = 1536;
    const outerHeight = 864;
    const screenX = 0;
    const screenY = 0;

    return [
      innerWidth, innerHeight, outerWidth, outerHeight,
      screenX, screenY, 0, 0, outerWidth, outerHeight,
      outerWidth, outerHeight, innerWidth, innerHeight, 24, 24, platform
    ].join('|');
  }

  getValue(urlParams, method = 'GET', startTime = 0, endTime = 0, randomNum1 = null, randomNum2 = null, randomNum3 = null) {
    const string1 = ABogus.generateString1(randomNum1, randomNum2, randomNum3);

    let paramsString;
    if (typeof urlParams === 'object') {
      paramsString = new URLSearchParams(urlParams).toString();
    } else {
      paramsString = urlParams;
    }

    const string2 = this.generateString2(paramsString, method, startTime, endTime);
    const string = string1 + string2;

    return ABogus.generateResult(string, 's4');
  }
}

module.exports = { ABogus, USERAGENT };
