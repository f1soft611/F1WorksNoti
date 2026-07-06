import express from 'express';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { scheduleJob } from 'node-schedule';
import { connPool } from './config/server.js';
import sharp from 'sharp'; // 이미지 처리 라이브러리

import sql from 'mssql';
import NewsAPI from 'newsapi';
import puppeteer from 'puppeteer';

const newsapi = new NewsAPI('7ed043a7f64043a795f7799708c581e3');

// URL별 웹서버 상태 추적 { url: { status: 'up'|'down', lastChecked: Date|null } }
const webServerStatuses = {};
const CRAWLING_FOOD_URL = 'https://sodambuffet.modoo.at/?link=9o1pogh8';
const fcmAdmin = admin.initializeApp({
  credential: admin.credential.cert('./f1works-firebase-adminsdk.json'),
});

const app = express();
dotenv.config();

app.set('port', process.env.PORT || 3000);

app.get('/', function (req, res) {
  res.sendfile('index.html');
});

app.get('/monitor', function (req, res) {
  res.sendFile('monitor.html', { root: '.' });
});

function getHealthCheckUrls() {
  const raw =
    process.env.WEB_SERVER_HEALTH_URLS ||
    process.env.WEB_SERVER_HEALTH_URL ||
    'https://f1lab.co.kr';

  return [
    ...new Set(
      raw
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean),
    ),
  ];
}

app.get('/api/server-status', function (req, res) {
  const urls = getHealthCheckUrls();
  const result = urls.map((url) => ({
    url,
    status: webServerStatuses[url]?.status || 'unknown',
    lastChecked: webServerStatuses[url]?.lastChecked
      ? webServerStatuses[url].lastChecked.toISOString()
      : null,
  }));
  res.json(result);
});

app.post('/api/run/:job', async function (req, res) {
  const job = req.params.job;
  const jobMap = {
    approve_001: () => notiApproveByType('001', '기안'),
    approve_008: () => notiApproveByType('008', '업무연락'),
    approve_004: () => notiApproveByType('004', '지출결의'),
    approve_031: () => notiApproveByType('031', '근태신청'),
    notice: () => notiNotice(),
    attendance: () => notiAttendance(),
    food: () => notiFoodAlert(),
    news: () => getNewsRank(),
    attendance_pending_approval: () => notiAttendancePendingApproval(),
    expense_claim: () => notiExpenseClaim(),
    expense_claim_reminder: () => notiExpenseClaim('expense_claim_reminder'),
    customer_management_count: () => notiCustomerManagementCount(),
    server_health: () => checkWebServerHealth(),
  };
  if (!jobMap[job]) {
    return res
      .status(400)
      .json({ ok: false, message: '알 수 없는 job: ' + job });
  }
  console.log(`[모니터링] 즉시 실행 요청: ${job}`);
  jobMap[job]();
  res.json({ ok: true, job });
});

app.get('/dietMenu', function (req, res) {
  getDietMenuLast(); // 오늘의 메뉴

  res.sendStatus(200); // equivalent to res.status(200).send('OK')
  return res;
});

app.listen(app.get('port'), () => {
  console.log(app.get('port'), '번 포트에서 대기중');

  let schedules = {};
  const expenseCron = process.env.SCH_TIME_EXPENSE || '0 9 * * 1-5';
  const expenseReminderCron = process.env.SCH_TIME_EXPENSE_REMINDER;

  const APPROVE_TYPES = [
    { code: '001', label: '기안' },
    { code: '008', label: '업무연락' },
    { code: '004', label: '지출결의' },
    { code: '031', label: '근태신청' },
  ];

  APPROVE_TYPES.forEach(({ code, label }) => {
    schedules[`sch01_${code}`] = scheduleJob(
      process.env.SCH_TIME1,
      function () {
        console.log(`${label} 미결재 알림 ing~`);
        notiApproveByType(code, label);
      },
    );
  });
  schedules['sch02'] = scheduleJob(process.env.SCH_TIME2, function () {
    console.log('공지 알림 ing~');
    notiNotice();
  });
  schedules['sch03'] = scheduleJob(process.env.SCH_TIME3, function () {
    console.log('출근기록 알림 ing~');
    notiAttendance();
  });
  schedules['sch04'] = scheduleJob(process.env.SCH_TIME4, function () {
    console.log('오늘의 메뉴 ing~');
    notiFoodAlert();
  });
  schedules['sch06'] = scheduleJob(process.env.SCH_TIME6, function () {
    console.log('뉴스 rank ing~');
    getNewsRank();
  });
  schedules['sch08'] = scheduleJob('0 9 * * 1-5', function () {
    console.log('근태신청 미결재 알림 ing~');
    notiAttendancePendingApproval();
  });
  schedules['sch09'] = scheduleJob(expenseCron, function () {
    if (!shouldSendExpenseNotification()) return;
    console.log('경비청구 알림 ing~');
    notiExpenseClaim();
  });
  schedules['sch09_reminder'] = scheduleJob(expenseReminderCron, function () {
    console.log('경비청구 리마인드 알림 ing~');
    notiExpenseClaim('expense_claim_reminder');
  });
  schedules['sch10'] = scheduleJob('0 9 * * 1', function () {
    console.log('고객관리 카운트 알림 ing~');
    notiCustomerManagementCount();
  });
  schedules['sch11'] = scheduleJob(
    process.env.SCH_TIME_HEALTH || '*/10 * * * *',
    function () {
      console.log('웹서버 헬스체크 ing~');
      checkWebServerHealth();
    },
  );
});

function isFirstMonday(date = new Date()) {
  return date.getDay() === 1 && date.getDate() <= 7;
}

function shouldSendExpenseNotification(date = new Date()) {
  // 공휴일 목록 (YYYYMMDD 형식)
  const holidays = [
    '20250101', // 신정
    '20250128', // 설날 연휴
    '20250129', // 설날
    '20250130', // 설날 연휴
    '20250301', // 삼일절
    '20250505', // 어린이날
    '20250506', // 어린이날 대체공휴일
    '20250606', // 현충일
    '20250815', // 광복절
    '20251003', // 개천절
    '20251006', // 추석
    '20251009', // 한글날
    '20251225', // 크리스마스
    '20260101', // 신정
    '20260216', // 설날 연휴
    '20260217', // 설날
    '20260218', // 설날 연휴
    '20260301', // 삼일절
    '20260505', // 어린이날
    '20260522', // 석가탄신일
    '20260606', // 현충일
    '20260815', // 광복절
    '20260924', // 추석 연휴
    '20260925', // 추석
    '20261003', // 개천절
    '20261225', // 크리스마스
  ];

  const year = date.getFullYear();
  const month = date.getMonth();

  // 해당 월의 1일부터 시작해서 평일이면서 공휴일이 아닌 첫 번째 날 찾기
  for (let day = 1; day <= 7; day++) {
    const checkDate = new Date(year, month, day);
    const dayOfWeek = checkDate.getDay();
    const dateStr = `${year}${String(month + 1).padStart(2, '0')}${String(
      day,
    ).padStart(2, '0')}`;

    // 평일(월~금)이면서 공휴일이 아닌 경우
    if (dayOfWeek >= 1 && dayOfWeek <= 5 && !holidays.includes(dateStr)) {
      return date.getDate() === day;
    }
  }

  return false;
}

function getNthWeekdayOfMonth(year, monthZeroBased, weekday, nth) {
  const firstDay = new Date(year, monthZeroBased, 1);
  const offset = (weekday - firstDay.getDay() + 7) % 7;
  const day = 1 + offset + (nth - 1) * 7;
  return new Date(year, monthZeroBased, day);
}

function formatKoreanDate(date) {
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  return `${date.getFullYear()}년 ${
    date.getMonth() + 1
  }월 ${date.getDate()}일(${dayNames[date.getDay()]})`;
}

function buildExpenseClaimMessage(now = new Date()) {
  const current = new Date(now);
  const prevMonth = new Date(current);
  prevMonth.setMonth(prevMonth.getMonth() - 1);

  const label = `${prevMonth.getMonth() + 1}월 경비청구서`;
  const dueDate = getNthWeekdayOfMonth(
    current.getFullYear(),
    current.getMonth(),
    1,
    4,
  ); // 4th Monday of current month

  const title = '[F1Works] 경비청구 알림';
  const body = `${label}\n기한내 제출 부탁드립니다.\n(경비가 없으시면 '제출없음'으로 제출해주세요)\n\n제출기한 : ${formatKoreanDate(
    dueDate,
  )}`;

  return { title, body };
}

function buildExpenseClaimReminderMessage(now = new Date()) {
  const base = buildExpenseClaimMessage(now);
  return {
    title: '[F1Works] 경비청구 리마인드',
    body: `${base.body}\n\n※ 리마인드: 매월 10일 안내 메시지입니다.`,
  };
}

function buildCustomerManagementMessage(customerRows) {
  const fallbackUrl = 'https://f1works.netlify.app/works/customer/contact';

  if (!customerRows || customerRows.length === 0) {
    return {
      title: '[고객관리] 전체 현황',
      body: '모두 정상입니다 👌',
      url: fallbackUrl,
    };
  }

  let totalNormal = 0;
  let totalWarning = 0;
  const warningList = [];

  customerRows.forEach((row) => {
    const status = row.STATUS || 'NORMAL';
    const customerName = row.CUSTOMER_NAME || '미지정';
    const managerName = row.MANAGER_NAME || '담당자미정';

    if (status === 'NORMAL') {
      totalNormal += 1;
    } else if (status === 'WARNING') {
      totalWarning += 1;
      warningList.push({ customerName, managerName });
    }
  });

  if (totalWarning === 0) {
    return {
      title: '[고객관리] 전체 현황',
      body: `[전체 현황]\n정상: ${totalNormal}건`,
      url: fallbackUrl,
    };
  }

  let body = `[전체 현황]\n정상: ${totalNormal}건 | 관리필요: ${totalWarning}건 ⚠️`;

  // if (warningList.length > 0) {
  //   body += '\n\n[관리필요 거래처]';
  //   warningList.forEach(({ customerName, managerName }) => {
  //     body += `\n- ${customerName} (최근 담당자: ${managerName})`;
  //   });
  // }
  body += '\n\n자세한 내용은 아래 [자세히 보기]에서 확인해주세요.';

  return {
    title: '[고객관리] 전체 현황',
    body: body,
    url: fallbackUrl,
  };
}

function getDate() {
  var today = new Date();
  var yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  // 날짜를 원하는 형식의 문자열로 변환
  var formattedToday =
    today.getFullYear() + '.' + (today.getMonth() + 1) + '.' + today.getDate(); // 오늘
  var formattedYesterday =
    yesterday.getFullYear() +
    '.' +
    (yesterday.getMonth() + 1) +
    '.' +
    yesterday.getDate(); // 하루전

  return formattedYesterday;
}

async function getDietMenu() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(CRAWLING_FOOD_URL, { waitUntil: 'domcontentloaded' });

  await page.waitForSelector('#innerWrap');

  const number1 = await page.$$eval(
    '.table_type1 ._boardContent tr',
    (data) => data.length,
  );
  const number2 = await page.$$eval(
    '.table_type1 ._boardContent tr:not(.notice)',
    (data) => data.length,
  );

  let idx = number1 - number2;

  let lastDate = await page.$eval(
    '#innerWrap > div.table_area > div > table > tbody > tr:nth-child(' +
      (idx + 1) +
      ') > td:nth-child(4)',
    (data) => data.textContent,
  );

  if (lastDate.indexOf('전') != -1) {
    if (lastDate.indexOf('시간 전') != -1) {
      let numLastDate = lastDate.replace('시간 전', '');
      if (numLastDate > 6) {
        await browser.close();
        return;
      }
    }

    await page.click(
      '#innerWrap > div.table_area > div > table > tbody > tr:nth-child(' +
        (idx + 1) +
        ')',
    );

    await page.waitForSelector('.content_view');

    const imgString = await page.evaluate(
      () => document.querySelector('.content_view').innerHTML,
    );

    notiFood(imgString);
  }

  await browser.close();

  // if (getDate() == lastDate) {
  // await browser.close();
  // return;
  // }
}

async function getDietMenuLast() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(CRAWLING_FOOD_URL, { waitUntil: 'domcontentloaded' });

  await page.waitForSelector('#innerWrap');

  const number1 = await page.$$eval(
    '.table_type1 ._boardContent tr',
    (data) => data.length,
  );
  const number2 = await page.$$eval(
    '.table_type1 ._boardContent tr:not(.notice)',
    (data) => data.length,
  );

  let idx = number1 - number2;

  await page.click(
    '#innerWrap > div.table_area > div > table > tbody > tr:nth-child(' +
      (idx + 1) +
      ')',
  );

  await page.waitForSelector('.photo_img img');

  const imgString = await page.evaluate(
    () => document.querySelector('.photo_img').innerHTML,
  );

  notiFood(imgString);

  await browser.close();
}

async function getNewsList() {
  await geNews('business');
  await geNews('entertainment');
  await geNews('general');
  await geNews('health');
  await geNews('science');
  await geNews('sports');
  await geNews('technology');
}

async function geNews(category) {
  // console.log('뉴스 피드 >> ', category);

  // To query /v2/top-headlines
  // All options passed to topHeadlines are optional, but you need to include at least one of them
  await newsapi.v2
    .topHeadlines({
      category: category,
      country: 'us',
    })
    .then((response) => {
      if (response.status === 'ok') {
        // console.log(response.articles);
        onRegNews(response.articles, category);
      } else {
        console.log(response.message);
      }
    });
}

async function onRegNews(newItems, category) {
  try {
    const pool = await connPool;

    for (const item of newItems) {
      const request = pool.request();

      // Assuming the stored procedure takes parameters: '@param1', '@title', '@url'
      request.input('factoryCode', sql.NVarChar(6), '000001');
      request.input('source', sql.NVarChar(100), item.source.name || '');
      request.input('author', sql.NVarChar(100), item.author || '');
      request.input('category', sql.NVarChar(20), category);
      request.input('title', sql.NVarChar(4000), item.title || '');
      request.input('description', sql.NVarChar('MAX'), item.description || '');
      request.input('url', sql.NVarChar(1000), item.url || '');
      request.input('urlToImage', sql.NVarChar(1000), item.urlToImage || '');
      request.input(
        'publishedAt',
        sql.NVarChar(14),
        convertToYmdHis(item.publishedAt) || '',
      );
      request.input('content', sql.NVarChar('MAX'), item.content || '');

      await request.query(
        'EXEC iPlusERP_F1SOFT.dbo.[SP_WEB_API_SET_NEWS] @factoryCode, @source, @author, @category, @title, @description, @url, @urlToImage, @publishedAt, @content',
      );
    }
  } catch (err) {
    console.log(err.message);
  }
}

async function getNewsRank() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  const url = 'https://news.nate.com/rank/?mid=n1000';

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const newsItems = [];
  for (var i = 1; i < 6; i++) {
    const imgUrl = await page.$eval(
      `#newsContents > div > div.postRankSubjectList.f_clear > div:nth-child(${i}) > div > a > span.ib > em > img`,
      (element) => element.getAttribute('src'),
    );
    const title = await page.$eval(
      `#newsContents > div > div.postRankSubjectList.f_clear > div:nth-child(${i}) > div > a > span.tb > h2`,
      (element) => element.textContent.trim(),
    );
    const content = await page.$eval(
      `#newsContents > div > div.postRankSubjectList.f_clear > div:nth-child(${i}) > div > a > span.tb`,
      (element) => {
        // h2를 제외한 모든 하위 엘리먼트의 텍스트 추출
        const h2Text = element.querySelector('h2');
        if (h2Text) {
          h2Text.remove();
        }
        return element.innerText.trim();
      },
    );
    const pubDate = await page.$eval(
      `#newsContents > div > div.postRankSubjectList.f_clear > div:nth-child(${i}) > div > span > em`,
      (element) => element.textContent.trim(),
    );
    const source = await page.$eval(
      `#newsContents > div > div.postRankSubjectList.f_clear > div:nth-child(${i}) > div > span`,
      (element) => {
        // em을 제외한 모든 하위 엘리먼트의 텍스트 추출
        const emText = element.querySelector('em');
        if (emText) {
          emText.remove();
        }
        return element.innerText.trim();
      },
    );
    const href = await page.$eval(
      `#newsContents > div > div.postRankSubjectList.f_clear > div:nth-child(${i}) > div > a`,
      (element) => element.getAttribute('href'),
    );

    newsItems.push({
      imgUrl,
      title,
      content,
      source,
      pubDate,
      href,
    });
  }

  // console.log('추출된 뉴스 리스스:', newsItems);

  onCreateNews(newsItems);

  await browser.close();
}

async function onCreateNews(newItems) {
  try {
    const pool = await connPool;

    for (const item of newItems) {
      const request = pool.request();

      // Assuming the stored procedure takes parameters: '@param1', '@title', '@url'
      request.input('factoryCode', sql.NVarChar(6), '000001');
      request.input('source', sql.NVarChar(100), item.source || '');
      request.input('author', sql.NVarChar(100), '네이트');
      request.input('category', sql.NVarChar(20), 'all');
      request.input('title', sql.NVarChar(4000), item.title || '');
      request.input('description', sql.NVarChar('MAX'), item.content || '');
      request.input('url', sql.NVarChar(1000), item.href || '');
      request.input('urlToImage', sql.NVarChar(1000), item.imgUrl || '');
      request.input(
        'publishedAt',
        sql.NVarChar(14),
        item.pubDate.replaceAll('-', '') || '',
      );
      request.input('content', sql.NVarChar('MAX'), '');
      request.input('rankFlag', sql.NVarChar(1), '1');

      await request.query(
        'EXEC iPlusERP_F1SOFT.dbo.[SP_WEB_API_SET_NEWS] @factoryCode, @source, @author, @category, @title, @description, @url, @urlToImage, @publishedAt, @content, @rankFlag',
      );
    }
  } catch (err) {
    console.log(err.message);
  }
}

async function getFunFm(pageIdx) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  const url = 'https://www.fmkorea.com/best';

  const funItems = [];

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const selectorMain = `#bd_189545458_0 > div > div.fm_best_widget._bd_pc > ul > li:nth-child(${pageIdx}) > div > h3 > a`;
    // 원하는 요소 클릭 및 페이지 이동
    await page.waitForSelector(selectorMain);

    let linkUrl = await page.$eval(selectorMain, (element) => {
      return 'https://www.fmkorea.com/best' + element.getAttribute('href');
    });
    const title = await page.$eval(selectorMain, (element) => {
      // em을 제외한 모든 하위 엘리먼트의 텍스트 추출
      const emText = element.querySelector('span');
      if (emText) {
        emText.remove();
      }
      return element.innerText.trim();
    });

    // Click on the element to navigate to another page
    await Promise.all([
      page.click(selectorMain),
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    ]);

    const contentSelector = `#bd_capture > div.rd_body.clear > article`;

    await page.waitForSelector(contentSelector);

    // Extract both text and image content
    const articleContent = await page.$eval(
      contentSelector,
      async (article) => {
        const video = article.querySelector('video');
        if (video) {
          video.remove();
        }

        const regexPattern =
          /<a\s+(?:[^>]*?\s+)?href=(?:'[^']*'|"[^"]*"|[^'">\s]+)(?:\s+[^>]*)?>\s*<img[^>]*>\s*<\/a>|<img[^>]*>|<div[^>]*>|<ul[^>]*>|<li[^>]*>|<span[^>]*>|<input[^>]*>|<label[^>]*>|<svg[^>]*>|<button[^>]*>|<video[^>]*>|color\s*:\s*#000[^;>]*;/g;

        const textContent = article
          .querySelector('#bd_capture > div.rd_body.clear > article > div')
          .innerHTML.replace(regexPattern, '')
          .trim();
        const imgElement = article.querySelector('img');
        const imageSrc = imgElement ? imgElement.getAttribute('src') : null;

        return { textContent, imageSrc };
      },
    );

    const { textContent, imageSrc } = articleContent;

    // 이미지를 포함하는 요소의 선택자
    const imgSelector = contentSelector + ' img';

    // img 태그를 찾고 해당 요소의 bounding box를 얻어옵니다.
    const imgElementHandle = await page.$(imgSelector);

    let imageSource = null;
    if (imgElementHandle) {
      const boundingBox = await imgElementHandle.boundingBox();

      if (boundingBox) {
        // bounding box를 사용하여 이미지를 클립하고 스크린샷을 찍습니다.
        const screenshotBuffer = await page.screenshot({
          clip: {
            x: Math.max(0, boundingBox.x), // Ensure x is not negative
            y: Math.max(0, boundingBox.y), // Ensure y is not negative
            width: Math.min(65535, boundingBox.width), // Ensure width is within range
            height: Math.min(65535, boundingBox.height * 0.5), // Ensure height is within range
          },
        });

        // 이미지 품질을 조절하고 압축
        const compressedBuffer = await sharp(screenshotBuffer)
          .resize({ width: 480 }) // 원하는 크기로 조정
          .jpeg({ quality: 30 }) // JPEG 포맷 사용 및 품질 설정 (0-100)
          .toBuffer();

        // 스크린샷 버퍼를 Base64로 변환합니다.
        const base64Screenshot = compressedBuffer.toString('base64');

        imageSource = `data:image/png;base64,${base64Screenshot} `;
      }
    } else {
      console.log('no image');
    }

    // Handle the extracted information as needed (e.g., store in funItems array)
    if (textContent || imageSrc || imageSource) {
      funItems.push({
        linkUrl,
        title,
        textContent,
        imageSrc,
        imageSource,
      });

      onCreateFun(funItems, 'fm');
    } else {
      console.error('No text or image content found.');
    }
  } catch (error) {
    console.error('An error occurred:', error);
  } finally {
    // Close Puppeteer
    await browser.close();
  }
}

async function getFunPpom(pageIdx) {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  const url = 'https://www.ppomppu.co.kr/hot.php?category=2';

  const funItems = [];

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const selectorMain = `body > div.wrapper > div.contents > div.container > div > div.board_box > table.board_table > tbody > tr:nth-child(${pageIdx}) > td:nth-child(4) > a`;
    // 원하는 요소 클릭 및 페이지 이동
    await page.waitForSelector(selectorMain);

    let linkUrl = await page.$eval(selectorMain, (element) => {
      return 'https://www.ppomppu.co.kr' + element.getAttribute('href');
    });
    const title = await page.$eval(selectorMain, (element) => {
      // em을 제외한 모든 하위 엘리먼트의 텍스트 추출
      const img = element.querySelector('img');
      if (img) {
        img.remove();
      }
      return element.innerText.trim();
    });

    // Click on the element to navigate to another page
    await Promise.all([
      page.click(selectorMain),
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    ]);

    const contentSelector = `body > div.wrapper > div.contents > div.container > div > table:nth-child(16) > tbody`;

    await page.waitForSelector(contentSelector);

    // Extract both text and image content
    const articleContent = await page.$eval(
      contentSelector,
      async (article) => {
        const autoMediaWrapperElement = article.querySelector(
          '.auto_media_wrapper.full.pc',
        );
        if (autoMediaWrapperElement) {
          autoMediaWrapperElement.remove();
        }
        const video = article.querySelector('video');
        if (video) {
          video.remove();
        }
        const textContent = article
          .querySelector('.board-contents')
          .innerHTML.replace(
            /<a\s+(?:[^>]*?\s+)?href=(?:'[^']*'|"[^"]*"|[^'">\s]+)(?:\s+[^>]*)?>\s*<img[^>]*>\s*<\/a>|<img[^>]*>|<div\s+class="auto_media_wrapper[^"]*\sfull\s+pc"[^>]*><\/div>|<video[^>]*>.*?<\/video>/g,
            '',
          )
          .trim();
        const imgElement = article.querySelector('img');
        const imageSrc = imgElement ? imgElement.getAttribute('src') : null;

        return { textContent, imageSrc };
      },
    );

    const { textContent, imageSrc } = articleContent;

    // 이미지를 포함하는 요소의 선택자
    const imgSelector = contentSelector + ' img';
    const imgElementHandle = await page.$(imgSelector);

    let imageSource = null;

    if (imgElementHandle) {
      const boundingBox = await imgElementHandle.boundingBox();

      if (boundingBox) {
        // bounding box를 사용하여 이미지를 클립하고 스크린샷을 찍습니다.
        const screenshotBuffer = await page.screenshot({
          clip: {
            x: Math.max(0, boundingBox.x), // Ensure x is not negative
            y: Math.max(0, boundingBox.y), // Ensure y is not negative
            width: Math.min(65535, boundingBox.width), // Ensure width is within range
            height: Math.min(65535, boundingBox.height * 0.5), // Ensure height is within range
          },
        });

        // 이미지 품질을 조절하고 압축
        const compressedBuffer = await sharp(screenshotBuffer)
          .resize({ width: 480 }) // 원하는 크기로 조정
          .jpeg({ quality: 30 }) // JPEG 포맷 사용 및 품질 설정 (0-100)
          .toBuffer();

        // 스크린샷 버퍼를 Base64로 변환합니다.
        const base64Screenshot = compressedBuffer.toString('base64');

        imageSource = `data:image/png;base64,${base64Screenshot} `;
      }
    } else {
      console.log('no image');
    }

    // Handle the extracted information as needed (e.g., store in funItems array)
    if (textContent || imageSrc || imageSource) {
      funItems.push({
        linkUrl,
        title,
        textContent,
        imageSrc,
        imageSource,
      });

      onCreateFun(funItems, 'ppom');
    } else {
      console.error('No text or image content found.');
    }
  } catch (error) {
    console.error('An error occurred:', error);
  } finally {
    // Close Puppeteer
    await browser.close();
  }
}

async function getFunBlind(pageIdx) {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  const url = 'https://www.teamblind.com/kr';

  const funItems = [];

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const selectorMain = `#wrap > section > div > div.contents > div.home-list > div.topic-list.best > div:nth-child(${pageIdx}) > a`;
    // 원하는 요소 클릭 및 페이지 이동
    await page.waitForSelector(selectorMain);

    let linkUrl = await page.$eval(selectorMain, (element) => {
      return 'https://www.teamblind.com' + element.getAttribute('href');
    });
    const title = await page.$eval(selectorMain, (element) => {
      // em을 제외한 모든 하위 엘리먼트의 텍스트 추출
      const img = element.querySelector('img');
      if (img) {
        img.remove();
      }
      return element.innerText.trim();
    });

    // Click on the element to navigate to another page
    await Promise.all([
      page.click(selectorMain),
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    ]);

    const contentSelector = `#wrap > section > div > div.contents > div.article-view-contents`;

    await page.waitForSelector(contentSelector);

    // Extract both text and image content
    const articleContent = await page.$eval(
      contentSelector,
      async (article) => {
        const autoMediaWrapperElement = article.querySelector(
          '.auto_media_wrapper.full.pc',
        );
        if (autoMediaWrapperElement) {
          autoMediaWrapperElement.remove();
        }
        const video = article.querySelector('video');
        if (video) {
          video.remove();
        }
        const textContent = article.querySelector('.contents-txt').innerHTML;
        const imgElement = article.querySelector('img');
        const imageSrc = imgElement ? imgElement.getAttribute('src') : null;

        return { textContent, imageSrc };
      },
    );

    const { textContent, imageSrc } = articleContent;

    // 이미지를 포함하는 요소의 선택자
    const imgSelector = contentSelector + ' img';
    const imgElementHandle = await page.$(imgSelector);

    let imageSource = null;

    if (imgElementHandle) {
      const boundingBox = await imgElementHandle.boundingBox();

      if (boundingBox) {
        // bounding box를 사용하여 이미지를 클립하고 스크린샷을 찍습니다.
        const screenshotBuffer = await page.screenshot({
          clip: {
            x: Math.max(0, boundingBox.x), // Ensure x is not negative
            y: Math.max(0, boundingBox.y), // Ensure y is not negative
            width: Math.min(65535, boundingBox.width), // Ensure width is within range
            height: Math.min(65535, boundingBox.height * 0.5), // Ensure height is within range
          },
        });

        // 이미지 품질을 조절하고 압축
        const compressedBuffer = await sharp(screenshotBuffer)
          .resize({ width: 480 }) // 원하는 크기로 조정
          .jpeg({ quality: 30 }) // JPEG 포맷 사용 및 품질 설정 (0-100)
          .toBuffer();

        // 스크린샷 버퍼를 Base64로 변환합니다.
        const base64Screenshot = compressedBuffer.toString('base64');

        imageSource = `data:image/png;base64,${base64Screenshot} `;
      }
    } else {
      console.log('no image');
    }

    // Handle the extracted information as needed (e.g., store in funItems array)
    if (textContent || imageSrc || imageSource) {
      funItems.push({
        linkUrl,
        title,
        textContent,
        imageSrc,
        imageSource,
      });

      onCreateFun(funItems, 'blind');
    } else {
      console.error('No text or image content found.');
    }
  } catch (error) {
    console.error('An error occurred:', error);
  } finally {
    // Close Puppeteer
    await browser.close();
  }
}

async function getFunNate(pageIdx) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  const url = 'https://pann.nate.com/';

  const funItems = [];

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const selectorMain = `#container > div.content.main > div.post-wrap > div.talkBox > div.today-talk.ellipsis > ul > li:nth-child(${pageIdx}) > div > div > div > a`;
    // 원하는 요소 클릭 및 페이지 이동
    await page.waitForSelector(selectorMain);

    let linkUrl = await page.$eval(selectorMain, (element) => {
      return 'https://pann.nate.com' + element.getAttribute('href');
    });
    const title = await page.$eval(selectorMain, (element) => {
      // em을 제외한 모든 하위 엘리먼트의 텍스트 추출
      const img = element.querySelector('img');
      if (img) {
        img.remove();
      }
      return element.innerText.trim();
    });

    // Click on the element to navigate to another page
    await Promise.all([
      page.click(selectorMain),
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    ]);

    const contentSelector = `#container > div.content.sub > div.viewarea > div.view-wrap > div.posting`;

    await page.waitForSelector(contentSelector);

    // Extract both text and image content
    const articleContent = await page.$eval(
      contentSelector,
      async (article) => {
        const video = article.querySelector('video');
        if (video) {
          video.remove();
        }

        const textContent = article
          .querySelector('#contentArea')
          .innerHTML.replace(
            /<a\s+(?:[^>]*?\s+)?href=(?:'[^']*'|"[^"]*"|[^'">\s]+)(?:\s+[^>]*)?>\s*<img[^>]*>\s*<\/a>|<img[^>]*>|<div\s+class="auto_media_wrapper[^"]*\sfull\s+pc"[^>]*><\/div>|<video[^>]*>.*?<\/video>/g,
            '',
          )
          .trim();
        const imgElement = article.querySelector('img');
        const imageSrc = imgElement ? imgElement.getAttribute('src') : null;

        return { textContent, imageSrc };
      },
    );

    const { textContent, imageSrc } = articleContent;

    // 이미지를 포함하는 요소의 선택자
    const imgSelector = contentSelector + ' img';
    const imgElementHandle = await page.$(imgSelector);

    let imageSource = null;

    if (imgElementHandle) {
      const boundingBox = await imgElementHandle.boundingBox();

      if (boundingBox) {
        // bounding box를 사용하여 이미지를 클립하고 스크린샷을 찍습니다.
        const screenshotBuffer = await page.screenshot({
          clip: {
            x: Math.max(0, boundingBox.x), // Ensure x is not negative
            y: Math.max(0, boundingBox.y), // Ensure y is not negative
            width: Math.min(65535, boundingBox.width), // Ensure width is within range
            height: Math.min(65535, boundingBox.height * 0.5), // Ensure height is within range
          },
        });

        // 이미지 품질을 조절하고 압축
        const compressedBuffer = await sharp(screenshotBuffer)
          .resize({ width: 480 }) // 원하는 크기로 조정
          .jpeg({ quality: 30 }) // JPEG 포맷 사용 및 품질 설정 (0-100)
          .toBuffer();

        // 스크린샷 버퍼를 Base64로 변환합니다.
        const base64Screenshot = compressedBuffer.toString('base64');

        imageSource = `data:image/png;base64,${base64Screenshot} `;
      }
    } else {
      console.log('no image');
    }

    // Handle the extracted information as needed (e.g., store in funItems array)
    if (textContent || imageSrc || imageSource) {
      funItems.push({
        linkUrl,
        title,
        textContent,
        imageSrc,
        imageSource,
      });

      onCreateFun(funItems, 'nate');
    } else {
      console.error('No text or image content found.');
    }
  } catch (error) {
    console.error('An error occurred:', error);
  } finally {
    // Close Puppeteer
    await browser.close();
  }
}

async function onCreateFun(funItems, linkSource) {
  try {
    const pool = await connPool;

    for (const item of funItems) {
      const request = pool.request();

      request.input('factoryCode', sql.NVarChar(6), '000001');
      request.input('linkNo', sql.NVarChar(100), '');
      request.input('title', sql.NVarChar(200), item.title || '');
      request.input('content', sql.NVarChar('max'), item.textContent || '');
      request.input(
        'contentImage',
        sql.NVarChar('max'),
        item.imageSrc ? item.imageSrc : '' || '',
      );
      request.input(
        'url',
        sql.NVarChar(200),
        item.linkUrl ? item.linkUrl : '' || '',
      );
      request.input(
        'imageSource',
        sql.NVarChar('max'),
        item.imageSource ? item.imageSource : '' || '',
      );
      request.input(
        'linkSource',
        sql.NVarChar('50'),
        linkSource ? linkSource : '' || '',
      );
      request.input('opmanCode', sql.NVarChar('max'), 'SYSTEM');
      request.input('iud', sql.NVarChar('max'), 'IU');

      await request.query(
        'EXEC iPlusERP_F1SOFT.dbo.[SP_WEB_API_SET_LINK] @factoryCode, @linkNo, @title, @url, @imageSource, @opmanCode, @iud, @linkSource, @content, @contentImage',
      );
    }
  } catch (err) {
    console.log(err.message);
  }
}

async function notiFood(imgString) {
  const registrationToken = [];

  try {
    const pool = await connPool;

    await pool
      .request()
      .query(
        "EXEC iPlusERP_F1SOFT.dbo.[SP_WEB_API_SET_FOOD] '000001', '" +
          imgString +
          "'",
      );

    const result = await pool
      .request()
      .query(
        "EXEC iPlusERP_F1SOFT.dbo.[SP_WEB_API_SUBSCRIBE_GET_USER_FOOD] '000001', ''",
      );

    result.recordset.forEach((el) => {
      registrationToken.push(el.FCM_TOKEN);
    });

    sendMessage(registrationToken, 'food');
  } catch (err) {
    console.log(err.message);
  }
}

async function notiFoodAlert() {
  const registrationToken = [];
  const registrationUsers = [];
  let receivers = [];
  let url = '';

  try {
    const pool = await connPool;

    const result = await pool
      .request()
      .query(
        "EXEC iPlusERP_F1SOFT.dbo.[SP_WEB_API_SUBSCRIBE_GET_USER_FOOD] '000001', ''",
      );

    result.recordset.forEach((el) => {
      registrationToken.push(el.FCM_TOKEN);
      registrationUsers.push(el.E_MAIL);
      url = el.URL;
    });

    // receivers 배열 만들기
    receivers = registrationUsers.map((user) => ({
      receiverId: user,
    }));

    // sendMessage(registrationToken, 'food');
    sendMessageFlow(receivers, 'food', url);
  } catch (err) {
    console.log(err.message);
  }
}

async function notiAttendance() {
  const registrationToken = [];
  const registrationUsers = [];
  let receivers = [];

  try {
    const pool = await connPool;

    const result = await pool
      .request()
      .query(
        "EXEC iPlusERP_F1SOFT.dbo.[SP_WEB_API_SUBSCRIBE_GET_USER_ATTENDANCE] '000001', ''",
      );

    result.recordset.forEach((el) => {
      registrationToken.push(el.FCM_TOKEN);
      registrationUsers.push(el.E_MAIL);
    });

    // receivers 배열 만들기
    receivers = registrationUsers.map((user) => ({
      receiverId: user,
    }));

    // sendMessage(registrationToken, 'attendance');
    sendMessageFlow(receivers, 'attendance', '');
  } catch (err) {
    console.log(err.message);
  }
}

async function notiApproveByType(typeCode, typeLabel) {
  const registrationToken = [];
  const registrationUsers = [];
  let receivers = [];

  try {
    const pool = await connPool;

    const result = await pool
      .request()
      .query(
        "EXEC iPlusERP_F1SOFT.dbo.[SP_WEB_API_SUBSCRIBE_GET_USER_APPROVE] '000001', '', '" +
          typeCode +
          "'",
      );

    result.recordset.forEach((el) => {
      registrationToken.push(el.FCM_TOKEN);
      registrationUsers.push(el.E_MAIL);
    });

    // receivers 배열 만들기
    receivers = registrationUsers.map((user) => ({
      receiverId: user,
    }));

    // sendMessage(registrationToken, 'approve');
    sendMessageFlow(
      receivers,
      typeCode ? `approve_${typeCode}` : 'approve',
      '',
    );
  } catch (err) {
    console.log(err.message);
  }
}

async function notiApprove() {
  // 기존 단일 호출을 유지하되, typeCode를 지정하지 않고 전체 조회
  await notiApproveByType('', '미결재');
}

async function notiAttendancePendingApproval() {
  const registrationUsers = [];
  let receivers = [];

  try {
    const pool = await connPool;

    // 프로시저 호출하여 근태신청 미결재 사용자 조회
    const result = await pool
      .request()
      .query(
        "EXEC iPlusERP_F1SOFT.dbo.[SP_WEB_API_ATTENDANCE_PENDING_APPROVAL_NOTIFY] '000001'",
      );

    // 반환된 결과에서 사용자 이메일 추출
    if (result.recordset && result.recordset.length > 0) {
      result.recordset.forEach((el) => {
        registrationUsers.push(el.E_MAIL);
      });
    }

    // receivers 배열 만들기
    receivers = registrationUsers.map((user) => ({
      receiverId: user,
    }));

    // Flow 메시지 전송
    sendMessageFlow(receivers, 'attendance_pending_approval', '');
  } catch (err) {
    console.log(err.message);
  }
}

async function notiCustomerManagementCount() {
  const registrationUsers = [];
  const customerRows = [];
  let receivers = [];

  try {
    const pool = await connPool;

    // 프로시저 호출하여 고객 관리 건수 조회
    const result = await pool
      .request()
      .query(
        "EXEC iPlusERP_F1SOFT.dbo.[SP_WEB_API_CUSTOMER_MANAGEMENT_COUNT_NOTI] '000001'",
      );

    // 반환된 결과에서 사용자 이메일 및 거래처 데이터 분류
    if (result.recordset && result.recordset.length > 0) {
      result.recordset.forEach((el) => {
        if (el.E_MAIL && el.E_MAIL.trim()) {
          // 알림 받을 사람 (이메일이 있는 행)
          registrationUsers.push(el.E_MAIL);
        } else if (el.STATUS) {
          // 거래처 정보 (STATUS가 있는 행)
          customerRows.push({
            CUSTOMER_NAME: el.CUSTOMER_NAME,
            MANAGER_NAME: el.MANAGER_NAME,
            STATUS: el.STATUS,
          });
        }
      });
    }

    const message = buildCustomerManagementMessage(customerRows);

    // receivers 배열 만들기
    receivers = registrationUsers.map((user) => ({
      receiverId: user,
    }));

    // Flow 메시지 전송
    sendMessageFlow(
      receivers,
      'customer_management_count',
      message.url,
      message,
    );
  } catch (err) {
    console.log(err.message);
  }
}

async function notiExpenseClaim(notiType = 'expense_claim') {
  const registrationUsers = [];
  let receivers = [];

  try {
    const pool = await connPool;

    const result = await pool
      .request()
      .query(
        "EXEC iPlusERP_F1SOFT.dbo.[SP_WEB_API_SUBSCRIBE_GET_USER_EXPENSE] '000001', ''",
      );

    if (result.recordset && result.recordset.length > 0) {
      result.recordset.forEach((el) => {
        if (el.E_MAIL) {
          registrationUsers.push(el.E_MAIL);
        }
      });
    }

    receivers = registrationUsers.map((user) => ({
      receiverId: user,
    }));

    sendMessageFlow(receivers, notiType, '');
  } catch (err) {
    console.log(err.message);
  }
}

async function notiNotice() {
  const registrationToken = [];
  const registrationUsers = [];
  let receivers = [];

  try {
    const pool = await connPool;

    const result = await pool
      .request()
      .query(
        "EXEC iPlusERP_F1SOFT.dbo.[SP_WEB_API_SUBSCRIBE_GET_USER_NOTICE] '000001', ''",
      );

    result.recordset.forEach((el) => {
      registrationToken.push(el.FCM_TOKEN);
      registrationUsers.push(el.E_MAIL);
    });

    // receivers 배열 만들기
    receivers = registrationUsers.map((user) => ({
      receiverId: user,
    }));

    // sendMessage(registrationToken, 'notice');
    sendMessageFlow(receivers, 'notice', '');
  } catch (err) {
    console.log(err.message);
  }
}

function sendMessage(registrationToken, notiGbn) {
  if (registrationToken.length == 0) {
    return;
  }

  let strBody = '';
  if (notiGbn === 'attendance') {
    strBody = '출근 기록이 없습니다.\n서두르세요!!';
  } else if (notiGbn === 'approve') {
    strBody = '미결재 문서가 있습니다.\n결재 또는 확인 부탁드립니다.';
  } else if (notiGbn === 'notice') {
    strBody = '새로운 공지가 있습니다.\n확인 부탁드립니다.';
  } else if (notiGbn === 'food') {
    strBody = '오늘의 메뉴가 등록 되었습니다.\n확인 해보세요!';
  }

  const message = {
    notification: {
      title: '알림',
      body: strBody,
    },
    tokens: registrationToken,
  };

  fcmAdmin
    .messaging()
    .sendEachForMulticast(message)
    .then((response) => {
      console.log('성공 Push >> ', notiGbn);
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          console.log(`Token ${message.tokens[idx]} failed:`, resp.error);
        }
      });
    })
    .catch((error) => {
      console.log('Error sending message:', error);
    });
}

function sendMessageFlow(registrationUsers, notiGbn, url, customMessage) {
  if (registrationUsers.length == 0) {
    return;
  }

  const monitorPageUrl = 'http://192.168.80.115:3000/monitor';
  let strTitle = customMessage?.title || '';
  let strBody = customMessage?.body || '';
  let strUrl = customMessage?.url || url || '';
  const approveTypeMap = {
    approve_001: '기안',
    approve_008: '업무연락',
    approve_004: '지출결의',
    approve_031: '근태신청',
  };
  if (!strTitle || !strBody) {
    if (notiGbn === 'attendance') {
      strTitle = '[그룹웨어] 근태 알림';
      strBody = '출근 기록이 없습니다. 서두르세요!!';
      strUrl = 'https://f1lab.co.kr';
    } else if (notiGbn === 'approve') {
      strTitle = '[그룹웨어] 미결재/미확인 문서 알림';
      strBody =
        '아직 결재하지 않거나 확인하지 않은 문서가 있습니다. 결재 또는 확인 부탁드립니다.';
      strUrl = 'https://f1lab.co.kr';
    } else if (notiGbn.startsWith('approve_')) {
      const label = approveTypeMap[notiGbn] || '미결재/미확인';
      strTitle = `[그룹웨어] ${label} 미결재/미확인 알림`;
      strBody = `${label} 문서 중 미결재/미확인 항목이 있습니다. 결재 또는 확인 부탁드립니다.`;
      strUrl = 'https://f1lab.co.kr';
    } else if (notiGbn === 'notice') {
      strTitle = '[그룹웨어] 공지 알림';
      strBody = '새로운 공지가 있습니다. 확인 부탁드립니다.';
      strUrl = 'https://f1lab.co.kr';
    } else if (notiGbn === 'food') {
      strTitle = '[소담] 오늘의 메뉴 알림';
      strBody = '오늘의 메뉴가 등록 되었습니다. 확인 해보세요!';
      strUrl = url;
    } else if (notiGbn === 'expense_claim') {
      const expenseMessage = buildExpenseClaimMessage();
      strTitle = expenseMessage.title;
      strBody = expenseMessage.body;
      strUrl = 'https://f1works.netlify.app/works/expense';
    } else if (notiGbn === 'expense_claim_reminder') {
      const expenseMessage = buildExpenseClaimReminderMessage();
      strTitle = expenseMessage.title;
      strBody = expenseMessage.body;
      strUrl = 'https://f1works.netlify.app/works/expense';
    } else if (notiGbn === 'attendance_pending_approval') {
      strTitle = '[그룹웨어] 근태신청 미결재 알림';
      strBody = '근태신청 결재가 지연되고 있습니다. 빠른 결재 부탁드립니다.';
      strUrl = 'https://f1lab.co.kr';
    } else if (notiGbn === 'customer_management_count') {
      strTitle = '[고객과의 연결고리] 담당자별 현황';
      strBody = '담당자별 현황을 확인하세요.';
      strUrl = url || 'https://f1works.netlify.app/works/customer/contact';
    } else if (notiGbn === 'server_down') {
      strTitle = '[운영서버] 접속 불가 알림';
      strBody = `운영 웹서버(${url})에 접속할 수 없습니다. 즉시 확인 바랍니다.`;
      strUrl = monitorPageUrl;
    } else if (notiGbn === 'server_up') {
      strTitle = '[운영서버] 접속 복구 알림';
      strBody = `운영 웹서버(${url}) 접속이 복구되었습니다.`;
      strUrl = monitorPageUrl;
    }
  }

  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-flow-api-key':
        '20250930111808951-2dddf02f-49fb-4807-92be-ddd57cfc54a5',
    },
    body: JSON.stringify({
      receivers: registrationUsers,
      title: strTitle,
      contents: strBody,
      url: strUrl,
    }),
  };

  fetch(
    'https://api.flow.team/v1/bots/bot@f1soft.co.kr/notifications/bulk',
    options,
  )
    .then((response) => response.json())
    .then((response) => console.log(response))
    .catch((err) => console.error(err));
}

async function getServerAlertReceivers() {
  try {
    const pool = await connPool;
    const result = await pool
      .request()
      .query(
        "EXEC iPlusERP_F1SOFT.dbo.[SP_WEB_API_SERVER_ALERT_GET_USER] '000001'",
      );
    return result.recordset.map((el) => ({ receiverId: el.E_MAIL }));
  } catch (err) {
    console.log('[헬스체크] 수신자 조회 오류:', err.message);
    return [];
  }
}

async function checkWebServerHealth() {
  const urls = getHealthCheckUrls();
  for (const url of urls) {
    await checkSingleServer(url);
  }
}

async function checkSingleServer(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  let isUp = false;
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    isUp = response.status < 500;
  } catch (err) {
    isUp = false;
  } finally {
    clearTimeout(timeoutId);
  }
  const prevStatus = webServerStatuses[url]?.status || 'up';
  const currentStatus = isUp ? 'up' : 'down';
  webServerStatuses[url] = { status: currentStatus, lastChecked: new Date() };
  console.log(`[헬스체크] ${url} → ${currentStatus} (이전: ${prevStatus})`);
  if (currentStatus !== prevStatus) {
    const receivers = await getServerAlertReceivers();
    if (receivers.length > 0) {
      sendMessageFlow(receivers, isUp ? 'server_up' : 'server_down', url);
    }
  }
}

function convertToYmdHis(timestamp) {
  const dateObject = new Date(timestamp);

  const year = dateObject.getUTCFullYear();
  const month = String(dateObject.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dateObject.getUTCDate()).padStart(2, '0');
  const hours = String(dateObject.getUTCHours()).padStart(2, '0');
  const minutes = String(dateObject.getUTCMinutes()).padStart(2, '0');
  const seconds = String(dateObject.getUTCSeconds()).padStart(2, '0');

  const YmdHis = `${year}${month}${day}${hours}${minutes}${seconds}`;
  return YmdHis;
}

function getRandomNumber(linkSource) {
  if (linkSource === 'fm') {
    return Math.floor(Math.random() * 10) + 5; // Generates a random number between 1 and 10
  } else if (linkSource === 'ppom') {
    return Math.floor(Math.random() * 10) + 6; // Generates a random number between 1 and 10
  } else if (linkSource === 'blind') {
    return Math.floor(Math.random() * 10) + 2; // Generates a random number between 1 and 10
  } else if (linkSource === 'nate') {
    return Math.floor(Math.random() * 10) + 2; // Generates a random number between 1 and 10
  }
}
