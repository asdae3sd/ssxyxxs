const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');
const sharp = require('sharp');

// 环境变量（不打印）
const urls = process.env.TARGET_URLS?.split(',') || [];
const cookieMap = JSON.parse(process.env.COOKIE_MAP || '{}');
const userAgent = process.env.USER_AGENT || 'Mozilla/5.0';
const IMGE_API_KEY = process.env.IMGE_API_KEY;
const ALBUM_ID = process.env.IMGE_ALBUM_ID;
const COOKIE_FILE = path.join(__dirname, 'cookies.json');

// 模糊处理（静默失败）
const blurImage = async (inputPath, outputPath) => {
  try {
    await sharp(inputPath)
      .blur(2)           // 轻微模糊，文字轮廓可见
      .jpeg({ quality: 30 })  // 降低清晰度，增加“噪点感”
      .toFile(outputPath);
  } catch (_) {
    console.error('图片处理失败');
  }
};

// 解析 Cookie（不打印）
const parseCookies = (cookieStr, domain) => {
  return cookieStr.split(';').map(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    return { name, value: rest.join('='), domain, path: '/', httpOnly: false, secure: true };
  });
};

// 加载本地 Cookie
const loadCookies = (domain) => {
  if (!fs.existsSync(COOKIE_FILE)) return null;
  try {
    const allCookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
    return allCookies[domain] || null;
  } catch (_) {
    return null;
  }
};

// 保存 Cookie（静默）
const saveCookies = async (page, domain) => {
  try {
    const cookies = await page.cookies();
    const allCookies = fs.existsSync(COOKIE_FILE)
      ? JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'))
      : {};
    allCookies[domain] = cookies;
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(allCookies, null, 2));
  } catch (_) {}
};

// 上传图床（仅提示失败）
const uploadToImge = async (filePath) => {
  const formdata = new FormData();
  formdata.append("key", IMGE_API_KEY);
  formdata.append("source", fs.createReadStream(filePath));
  formdata.append("album_id", ALBUM_ID);
  formdata.append("nsfw", '1');

  try {
    const response = await fetch("https://im.ge/api/1/upload", {
      method: 'POST',
      body: formdata,
    });

    if (!response.ok) {
      console.error('图片上传失败');
      return null;
    }

    const text = await response.text();
    try {
      const data = JSON.parse(text);
      return data?.image?.url || null;
    } catch (_) {
      console.error('上传响应解析失败');
      return null;
    }
  } catch (_) {
    console.error('上传请求失败');
    return null;
  }
};

// 主流程：串行处理每个 URL
(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    // 串行循环：for...of 确保顺序执行
    for (let index = 0; index < urls.length; index++) {
      const url = urls[index];
      let page;

      try {
        page = await browser.newPage();
        await page.setUserAgent(userAgent);
        await page.setViewport({ width: 1280, height: 800 });
        const domain = new URL(url).hostname;

        // 设置 Cookie
        let cookies = loadCookies(domain);
        if (!cookies && cookieMap[domain]) {
          cookies = parseCookies(cookieMap[domain], domain);
        }
        if (cookies) await page.setCookie(...cookies);

        // 访问页面
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {
          throw new Error('页面加载超时或失败');
        });

        // Streamlit 特殊处理
        if (url.includes('streamlit.app')) {
          try {
            await page.waitForSelector('button', { timeout: 10000 });
            const buttons = await page.$$('button');
            for (const btn of buttons) {
              const text = await btn.evaluate(el => el.innerText.trim());
              if (text.includes('Manage app')) {
                await btn.click();
                break;
              }
            }
          } catch (_) {}
        }

        // 截图
        const screenshotPath = path.join(__dirname, `screenshot_${index + 1}.jpg`);
        await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 80 }).catch(() => {
          throw new Error('截图失败');
        });

        // 模糊 + 上传
        const blurredPath = path.join(__dirname, `blurred_${index + 1}.jpg`);
        await blurImage(screenshotPath, blurredPath);

        if (fs.existsSync(blurredPath)) {
          await uploadToImge(blurredPath);
        }

        // 保存 Cookie
        await saveCookies(page, domain);

      } catch (err) {
        console.error(`任务失败（第 ${index + 1} 个）: ${err.message}`);
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

  } catch (err) {
    console.error('浏览器启动失败');
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})();
