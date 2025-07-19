// Netlify Functions용 주식 데이터 API
const fetch = require('node-fetch');

// 메모리 캐시 (서버리스 환경에서는 제한적)
let dataCache = null;
let lastUpdate = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5분

// Yahoo Finance 심볼 매핑
const YAHOO_SYMBOLS = {
  'kospi': '^KS11',
  'kosdaq': '^KQ11', 
  'sp500': '^GSPC',
  'nasdaq100': '^NDX',
  'usdkrw': 'USDKRW=X',
  'jpykrw': 'JPYKRW=X'
};

// 여러 프록시를 시도하는 안정적인 fetch 함수
async function fetchWithProxies(targetUrl, symbol) {
  const proxies = [
    `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`,
    `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`
  ];
  
  for (const proxyUrl of proxies) {
    try {
      console.log(`Trying proxy for ${symbol}: ${proxyUrl.split('?')[0]}`);
      const res = await fetch(proxyUrl, { timeout: 15000 });
      
      if (!res.ok) {
        console.log(`Proxy failed with status ${res.status}`);
        continue;
      }
      
      let parsed;
      if (proxyUrl.includes('allorigins.win')) {
        const data = await res.json();
        parsed = JSON.parse(data.contents);
      } else {
        parsed = await res.json();
      }
      
      return parsed;
    } catch (e) {
      console.log(`Proxy error for ${symbol}: ${e.message}`);
      continue;
    }
  }
  
  throw new Error(`All proxies failed for ${symbol}`);
}

// Yahoo Finance에서 단일 지수 데이터 가져오기
async function fetchYahooIndex(symbol) {
  try {
    const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2d`;
    const parsed = await fetchWithProxies(targetUrl, symbol);
    
    const result = parsed.chart.result[0];
    const close = result.indicators.quote[0].close;
    
    let prev = close[0];
    let curr = close[1];
    
    // JPY/KRW의 경우 100을 곱해서 100엔 기준으로 변환
    if (symbol === 'JPYKRW=X') {
      prev = prev * 100;
      curr = curr * 100;
    }
    
    const change = curr - prev;
    const percent = (change / prev) * 100;
    
    return {
      symbol,
      value: curr.toLocaleString(undefined, {maximumFractionDigits:2}),
      change: `${change >= 0 ? '+' : ''}${change.toFixed(2)}`,
      percent: `${change >= 0 ? '+' : ''}${percent.toFixed(2)}%`,
      up: change >= 0,
      rawValue: curr,
      rawChange: change
    };
  } catch (e) {
    console.error(`Error fetching ${symbol}:`, e);
    return null;
  }
}

// 히스토리 데이터 가져오기
async function fetchHistory(symbol, isJPY = false) {
  try {
    const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=7d`;
    const parsed = await fetchWithProxies(targetUrl, symbol);
    
    const result = parsed.chart.result[0];
    const timestamps = result.timestamp;
    const closes = result.indicators.quote[0].close;
    
    const historyDays = [];
    for (let i = Math.max(0, closes.length - 5); i < closes.length - 1; i++) {
      const date = new Date(timestamps[i] * 1000);
      const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;
      
      let value = closes[i];
      let prevValue = i > 0 ? closes[i-1] : closes[i];
      
      if (isJPY) {
        value = value * 100;
        prevValue = prevValue * 100;
      }
      
      const valueStr = value.toLocaleString(undefined, {maximumFractionDigits: isJPY ? 1 : 2});
      const change = value - prevValue;
      const isUp = change >= 0;
      
      historyDays.push({
        date: dateStr,
        value: valueStr,
        change: change.toFixed(isJPY ? 1 : 2),
        isUp: isUp
      });
    }
    
    return historyDays;
  } catch (e) {
    console.error(`Error fetching history for ${symbol}:`, e);
    return [];
  }
}

// 모든 데이터를 병렬로 수집
async function collectAllData() {
  try {
    console.log('Starting data collection...');
    
    // 병렬로 모든 데이터 가져오기
    const results = await Promise.allSettled([
      fetchYahooIndex(YAHOO_SYMBOLS.kospi),
      fetchYahooIndex(YAHOO_SYMBOLS.kosdaq),
      fetchYahooIndex(YAHOO_SYMBOLS.sp500),
      fetchYahooIndex(YAHOO_SYMBOLS.nasdaq100),
      fetchYahooIndex(YAHOO_SYMBOLS.usdkrw),
      fetchYahooIndex(YAHOO_SYMBOLS.jpykrw)
    ]);
    
    // 히스토리 데이터도 병렬로 가져오기
    const historyResults = await Promise.allSettled([
      fetchHistory(YAHOO_SYMBOLS.kospi),
      fetchHistory(YAHOO_SYMBOLS.kosdaq),
      fetchHistory(YAHOO_SYMBOLS.sp500),
      fetchHistory(YAHOO_SYMBOLS.nasdaq100),
      fetchHistory(YAHOO_SYMBOLS.usdkrw),
      fetchHistory(YAHOO_SYMBOLS.jpykrw, true) // JPY는 특별 처리
    ]);
    
    const symbols = ['kospi', 'kosdaq', 'sp500', 'nasdaq100', 'usdkrw', 'jpykrw'];
    const data = {};
    
    results.forEach((result, index) => {
      const symbol = symbols[index];
      const main = result.status === 'fulfilled' ? result.value : null;
      const history = historyResults[index].status === 'fulfilled' ? historyResults[index].value : [];
      
      if (main) {
        data[symbol] = {
          main: main,
          history: history
        };
        console.log(`✅ ${symbol}: Success`);
      } else {
        console.log(`❌ ${symbol}: Failed`);
      }
    });
    
    console.log(`Data collection completed. Success: ${Object.keys(data).length}/${symbols.length}`);
    return data;
    
  } catch (error) {
    console.error('Error in collectAllData:', error);
    return {};
  }
}

// Netlify Function 핸들러
exports.handler = async (event, context) => {
  console.log('Function called');
  
  try {
    // CORS 헤더 설정
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Content-Type': 'application/json'
    };
    
    // OPTIONS 요청 처리 (CORS preflight)
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers,
        body: ''
      };
    }
    
    // 캐시 확인
    const now = Date.now();
    if (dataCache && lastUpdate && (now - lastUpdate) < CACHE_DURATION) {
      console.log('Returning cached data');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          timestamp: new Date().toISOString(),
          data: dataCache,
          cached: true,
          cacheAge: Math.floor((now - lastUpdate) / 1000)
        })
      };
    }
    
    // 새 데이터 수집
    console.log('Fetching fresh data');
    const freshData = await collectAllData();
    
    // 캐시 업데이트
    dataCache = freshData;
    lastUpdate = now;
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        data: freshData,
        cached: false,
        cacheAge: 0
      })
    };
    
  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Internal server error',
        message: error.message
      })
    };
  }
}; 