// Netlify Functions용 주식 데이터 API
const fetch = require('node-fetch');

// 메모리 캐시 (서버리스 환경에서는 제한적)
let dataCache = null;
let lastUpdate = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5분

// Yahoo Finance 심볼 매핑
const YAHOO_SYMBOLS = {
  'KOSPI': '^KS11',
  'KOSDAQ': '^KQ11', 
  'SP500': '^GSPC',
  'NASDAQ100': '^NDX',
  'USD_KRW': 'USDKRW=X',
  'JPY_KRW': 'JPYKRW=X'
};

// Yahoo Finance에서 단일 지수 데이터 가져오기
async function fetchYahooIndex(symbol) {
  const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2d`;
  const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
  
  try {
    const res = await fetch(proxyUrl);
    const data = await res.json();
    const parsed = JSON.parse(data.contents);
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
  const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=7d`;
  const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
  
  try {
    const res = await fetch(proxyUrl);
    const data = await res.json();
    const parsed = JSON.parse(data.contents);
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
    return null;
  }
}

// 모든 데이터 수집
async function collectAllData() {
  console.log('Collecting fresh data from Yahoo Finance...');
  
  try {
    // 병렬로 모든 데이터 수집
    const [
      kospi, kosdaq, sp500, nasdaq100, usdkrw, jpykrw,
      kospiHistory, kosdaqHistory, sp500History, nasdaq100History, usdkrwHistory, jpykrwHistory
    ] = await Promise.all([
      // 메인 데이터
      fetchYahooIndex(YAHOO_SYMBOLS.KOSPI),
      fetchYahooIndex(YAHOO_SYMBOLS.KOSDAQ),
      fetchYahooIndex(YAHOO_SYMBOLS.SP500),
      fetchYahooIndex(YAHOO_SYMBOLS.NASDAQ100),
      fetchYahooIndex(YAHOO_SYMBOLS.USD_KRW),
      fetchYahooIndex(YAHOO_SYMBOLS.JPY_KRW),
      
      // 히스토리 데이터
      fetchHistory(YAHOO_SYMBOLS.KOSPI),
      fetchHistory(YAHOO_SYMBOLS.KOSDAQ),
      fetchHistory(YAHOO_SYMBOLS.SP500),
      fetchHistory(YAHOO_SYMBOLS.NASDAQ100),
      fetchHistory(YAHOO_SYMBOLS.USD_KRW),
      fetchHistory(YAHOO_SYMBOLS.JPY_KRW, true)
    ]);
    
    return {
      timestamp: new Date().toISOString(),
      data: {
        kospi: { main: kospi, history: kospiHistory },
        kosdaq: { main: kosdaq, history: kosdaqHistory },
        sp500: { main: sp500, history: sp500History },
        nasdaq100: { main: nasdaq100, history: nasdaq100History },
        usdkrw: { main: usdkrw, history: usdkrwHistory },
        jpykrw: { main: jpykrw, history: jpykrwHistory }
      }
    };
  } catch (error) {
    console.error('Error collecting data:', error);
    throw error;
  }
}

// Netlify Function 핸들러
exports.handler = async (event, context) => {
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
  
  try {
    const now = Date.now();
    
    // 캐시가 유효한지 확인
    if (dataCache && lastUpdate && (now - lastUpdate) < CACHE_DURATION) {
      console.log('Returning cached data');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ...dataCache,
          cached: true,
          cacheAge: Math.floor((now - lastUpdate) / 1000)
        })
      };
    }
    
    // 새로운 데이터 수집
    const freshData = await collectAllData();
    
    // 캐시 업데이트
    dataCache = freshData;
    lastUpdate = now;
    
    console.log('Data collection completed successfully');
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ...freshData,
        cached: false
      })
    };
    
  } catch (error) {
    console.error('Function error:', error);
    
    // 에러 발생 시 캐시된 데이터라도 반환
    if (dataCache) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ...dataCache,
          cached: true,
          error: 'Fresh data unavailable, serving cached data'
        })
      };
    }
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to fetch stock data',
        message: error.message
      })
    };
  }
}; 