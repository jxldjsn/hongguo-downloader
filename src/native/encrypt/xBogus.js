/**
 * xBogus encryption for TikTok
 * Ported from Python implementation
 */

const crypto = require('crypto');

const STRING = "Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=";
const ARRAY = [
  ...Array(48).fill(null),
  ...Array.from({ length: 10 }, (_, i) => i),
  ...Array(39).fill(null),
  ...Array.from({ length: 6 }, (_, i) => i + 10)
];
const CANVAS = 3873194319;

class XBogus {
  static disturbArray(a, b, e, d, c, f, t, n, o, i, r, _, x, u, s, l, v, h, g) {
    const array = new Array(19).fill(0);
    array[0] = a; array[10] = b; array[1] = e; array[11] = d;
    array[2] = c; array[12] = f; array[3] = t; array[13] = n;
    array[4] = o; array[14] = i; array[5] = r; array[15] = _;
    array[6] = x; array[16] = u; array[7] = s; array[17] = l;
    array[8] = v; array[18] = h; array[9] = g;
    return array;
  }

  static generateGarbled1(a, b, e, d, c, f, t, n, o, i, r, _, x, u, s, l, v, h, g) {
    const array = new Array(19).fill(0);
    array[0] = a; array[1] = r; array[2] = b; array[3] = _;
    array[4] = e; array[5] = x; array[6] = d; array[7] = u;
    array[8] = c; array[9] = s; array[10] = f; array[11] = l;
    array[12] = t; array[13] = v; array[14] = n; array[15] = h;
    array[16] = o; array[17] = g; array[18] = i;
    return array.map(v => String.fromCharCode(Math.floor(v))).join('');
  }

  static generateNum(text) {
    const result = [];
    for (let i = 0; i < 21; i += 3) {
      result.push(
        (text.charCodeAt(i) << 16) |
        (text.charCodeAt(i + 1) << 8) |
        (text.charCodeAt(i + 2))
      );
    }
    return result;
  }

  static generateGarbled2(a, b, c) {
    return String.fromCharCode(a) + String.fromCharCode(b) + c;
  }

  static generateGarbled3(a, b) {
    const d = Array.from({ length: 256 }, (_, i) => i);
    let c = 0;
    let f = "";

    for (let bIdx = 0; bIdx < 256; bIdx++) {
      c = (c + d[bIdx] + a.charCodeAt(bIdx % a.length)) % 256;
      const e = d[bIdx];
      d[bIdx] = d[c];
      d[c] = e;
    }

    let t = 0;
    c = 0;
    for (let bIdx = 0; bIdx < b.length; bIdx++) {
      t = (t + 1) % 256;
      c = (c + d[t]) % 256;
      const e = d[t];
      d[t] = d[c];
      d[c] = e;
      f += String.fromCharCode(b.charCodeAt(bIdx) ^ d[(d[t] + d[c]) % 256]);
    }
    return f;
  }

  static calculateMd5(inputString) {
    let array;
    if (typeof inputString === 'string') {
      array = this.md5ToArray(inputString);
    } else if (Array.isArray(inputString)) {
      array = inputString;
    } else {
      throw new TypeError('Invalid input type');
    }

    return crypto.createHash('md5').update(Buffer.from(array)).digest('hex');
  }

  static md5ToArray(md5Str) {
    if (typeof md5Str === 'string' && md5Str.length > 32) {
      return Array.from(md5Str).map(char => char.charCodeAt(0));
    } else {
      const result = [];
      for (let index = 0; index < md5Str.length; index += 2) {
        result.push(
          (ARRAY[md5Str.charCodeAt(index)] << 4) |
          ARRAY[md5Str.charCodeAt(index + 1)]
        );
      }
      return result;
    }
  }

  static processUrlPath(urlPath) {
    return this.md5ToArray(
      this.calculateMd5(
        this.md5ToArray(
          this.calculateMd5(urlPath)
        )
      )
    );
  }

  static generateStr(num) {
    const values = [num & 16515072, num & 258048, num & 4032, num & 63];
    const shifts = [18, 12, 6, 0];
    return values.map((v, i) => STRING[v >> shifts[i]]).join('');
  }

  static handleUa(a, b) {
    const d = Array.from({ length: 256 }, (_, i) => i);
    let c = 0;

    for (let i = 0; i < 256; i++) {
      c = (c + d[i] + a.charCodeAt(i % a.length)) % 256;
      [d[i], d[c]] = [d[c], d[i]];
    }

    let t = 0;
    c = 0;
    const result = Buffer.alloc(b.length);

    for (let i = 0; i < b.length; i++) {
      t = (t + 1) % 256;
      c = (c + d[t]) % 256;
      [d[t], d[c]] = [d[c], d[t]];
      result[i] = b[i] ^ d[(d[t] + d[c]) % 256];
    }

    return result;
  }

  static generateUaArray(userAgent, params) {
    const uaKey = ['\u0000', '\u0001', String.fromCharCode(params)];
    const value = this.handleUa(uaKey.join(''), Buffer.from(userAgent, 'utf-8'));
    const base64Value = value.toString('base64');
    const md5Hash = crypto.createHash('md5').update(base64Value).digest();
    return Array.from(md5Hash);
  }

  static generateXBogus(query, params, userAgent, timestamp) {
    const uaArray = this.generateUaArray(userAgent, params);
    const array = [
      64,
      0.00390625,
      1,
      params,
      query[query.length - 2],
      query[query.length - 1],
      69,
      63,
      uaArray[uaArray.length - 2],
      uaArray[uaArray.length - 1],
      (timestamp >> 24) & 255,
      (timestamp >> 16) & 255,
      (timestamp >> 8) & 255,
      (timestamp >> 0) & 255,
      (CANVAS >> 24) & 255,
      (CANVAS >> 16) & 255,
      (CANVAS >> 8) & 255,
      (CANVAS >> 0) & 255,
      null
    ];

    let zero = 0;
    for (let i = 0; i < array.length - 1; i++) {
      let val = array[i];
      if (typeof val === 'number' && !Number.isInteger(val)) {
        val = Math.floor(val);
      }
      zero ^= val;
    }
    array[array.length - 1] = zero;

    const disturbed = this.disturbArray(...array);
    let garbled = this.generateGarbled1(...disturbed);
    garbled = this.generateGarbled2(2, 255, this.generateGarbled3("\xff", garbled));

    return this.generateNum(garbled).map(i => this.generateStr(i)).join('');
  }

  static getXBogus(query, params = 8, userAgent = null, testTime = null) {
    if (!userAgent) {
      userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    }

    const timestamp = testTime || Math.floor(Date.now() / 1000);

    let queryString;
    if (typeof query === 'object') {
      queryString = new URLSearchParams(query).toString();
    } else {
      queryString = query;
    }

    const processedQuery = this.processUrlPath(queryString);
    return this.generateXBogus(processedQuery, params, userAgent, timestamp);
  }
}

module.exports = { XBogus };
