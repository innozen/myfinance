// Netlify Functions용 주식 데이터 API
const fetch = require('node-fetch');

// 메모리 캐시 (서버리스 환경에서는 제한적)
let dataCache = null;
let lastUpdate = null;
const CACHE_DURATION = 0; // 캐시 비활성화 (테스트용)

// Yahoo Finance 심볼 매핑 (대체 심볼 포함)
const YAHOO_SYMBOLS = {
  'kospi': '^KS11',
  'kosdaq': '^KQ11', 
  'sp500': '^GSPC',
  'nasdaq100': '^NDX',  // 원래 심볼 유지
  'usdkrw': 'USDKRW=X',
  'jpykrw': 'JPYKRW=X'  // 원래 심볼 유지
};

// 대체 심볼 매핑 (실패 시 사용)
const FALLBACK_SYMBOLS = {
  'nasdaq100': '^IXIC',  // NASDAQ Composite
  'jpykrw': 'JPY=X'      // 단순화된 JPY 심볼
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
      const res = await fetch(proxyUrl, { timeout: 20000 });
      
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
    console.log(`🔄 Starting fetch for ${symbol}`);
    const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2d`;
    const parsed = await fetchWithProxies(targetUrl, symbol);
    
    if (!parsed || !parsed.chart || !parsed.chart.result || !parsed.chart.result[0]) {
      throw new Error(`Invalid response structure for ${symbol}`);
    }
    
    const result = parsed.chart.result[0];
    
    if (!result.indicators || !result.indicators.quote || !result.indicators.quote[0] || !result.indicators.quote[0].close) {
      throw new Error(`Missing price data for ${symbol}`);
    }
    
    const close = result.indicators.quote[0].close;
    
    if (!close || close.length < 2) {
      throw new Error(`Insufficient price data for ${symbol}: ${close ? close.length : 0} points`);
    }
    
    let prev = close[close.length - 2];
    let curr = close[close.length - 1];
    
    if (prev === null || prev === undefined || curr === null || curr === undefined) {
      throw new Error(`Invalid price values for ${symbol}: prev=${prev}, curr=${curr}`);
    }
    
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
    console.log(`Fetching history for ${symbol}...`);
    const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=7d`;
    const parsed = await fetchWithProxies(targetUrl, symbol);
    
    if (!parsed || !parsed.chart || !parsed.chart.result || !parsed.chart.result[0]) {
      console.error(`Invalid response structure for ${symbol} history`);
      return [];
    }
    
    const result = parsed.chart.result[0];
    
    if (!result.timestamp || !result.indicators || !result.indicators.quote || !result.indicators.quote[0] || !result.indicators.quote[0].close) {
      console.error(`Missing data fields for ${symbol} history`);
      return [];
    }
    
    const timestamps = result.timestamp;
    const closes = result.indicators.quote[0].close;
    
    // null 값 필터링
    const validData = [];
    for (let i = 0; i < timestamps.length && i < closes.length; i++) {
      if (timestamps[i] && closes[i] !== null && closes[i] !== undefined) {
        validData.push({
          timestamp: timestamps[i],
          close: closes[i]
        });
      }
    }
    
    if (validData.length < 2) {
      console.error(`Insufficient valid data for ${symbol} history: ${validData.length} points`);
      return [];
    }
    
    const historyDays = [];
    for (let i = Math.max(0, validData.length - 5); i < validData.length - 1; i++) {
      const date = new Date(validData[i].timestamp * 1000);
      const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;
      
      let value = validData[i].close;
      let prevValue = i > 0 ? validData[i-1].close : validData[i].close;
      
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
    
    console.log(`✅ History for ${symbol}: ${historyDays.length} days`);
    return historyDays;
  } catch (e) {
    console.error(`❌ Error fetching history for ${symbol}:`, e.message);
    return [];
  }
}

// 모든 데이터를 병렬로 수집
async function collectAllData() {
  try {
    console.log('Starting data collection...');
    
    // 순차적으로 데이터 가져오기 (안정성 향상)
    const symbols = ['kospi', 'kosdaq', 'sp500', 'nasdaq100', 'usdkrw', 'jpykrw'];
    const symbolCodes = [YAHOO_SYMBOLS.kospi, YAHOO_SYMBOLS.kosdaq, YAHOO_SYMBOLS.sp500, YAHOO_SYMBOLS.nasdaq100, YAHOO_SYMBOLS.usdkrw, YAHOO_SYMBOLS.jpykrw];
    
    const results = [];
    const historyResults = [];
    
    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];
      const symbolCode = symbolCodes[i];
      
      console.log(`\n--- Processing ${symbol} (${symbolCode}) ---`);
      
             // 메인 데이터 가져오기 (대체 심볼 시도 포함)
       let mainData = null;
       let mainError = null;
       
       try {
         mainData = await fetchYahooIndex(symbolCode);
         console.log(`✅ Main data for ${symbol} (${symbolCode}): Success`);
       } catch (error) {
         mainError = error;
         console.log(`❌ Main data for ${symbol} (${symbolCode}): ${error.message}`);
         
         // 대체 심볼 시도
         const fallbackSymbol = FALLBACK_SYMBOLS[symbol];
         if (fallbackSymbol) {
           try {
             console.log(`🔄 Trying fallback symbol for ${symbol}: ${fallbackSymbol}`);
             mainData = await fetchYahooIndex(fallbackSymbol);
             console.log(`✅ Main data for ${symbol} (${fallbackSymbol}): Success`);
           } catch (fallbackError) {
             console.log(`❌ Fallback symbol for ${symbol} (${fallbackSymbol}): ${fallbackError.message}`);
           }
         }
       }
       
       if (mainData) {
         results.push({ status: 'fulfilled', value: mainData });
       } else {
         results.push({ status: 'rejected', reason: mainError });
       }
      
             // 히스토리 데이터 가져오기 (대체 심볼 시도 포함)
       let historyData = null;
       let historyError = null;
       
       try {
         historyData = await fetchHistory(symbolCode, symbol === 'jpykrw');
         console.log(`✅ History data for ${symbol} (${symbolCode}): ${historyData ? historyData.length : 0} days`);
       } catch (error) {
         historyError = error;
         console.log(`❌ History data for ${symbol} (${symbolCode}): ${error.message}`);
         
         // 대체 심볼 시도
         const fallbackSymbol = FALLBACK_SYMBOLS[symbol];
         if (fallbackSymbol) {
           try {
             console.log(`🔄 Trying fallback symbol history for ${symbol}: ${fallbackSymbol}`);
             historyData = await fetchHistory(fallbackSymbol, symbol === 'jpykrw');
             console.log(`✅ History data for ${symbol} (${fallbackSymbol}): ${historyData ? historyData.length : 0} days`);
           } catch (fallbackError) {
             console.log(`❌ Fallback symbol history for ${symbol} (${fallbackSymbol}): ${fallbackError.message}`);
           }
         }
       }
       
       if (historyData) {
         historyResults.push({ status: 'fulfilled', value: historyData });
       } else {
         historyResults.push({ status: 'rejected', reason: historyError });
       }
      
      // 요청 간 딜레이 (프록시 과부하 방지)
      if (i < symbols.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500)); // 0.5초 대기
      }
         }
     
     // const symbols는 위에서 이미 정의됨
     const data = {};
    
    results.forEach((result, index) => {
      const symbol = symbols[index];
      const symbolCode = Object.values(YAHOO_SYMBOLS)[index];
      const main = result.status === 'fulfilled' ? result.value : null;
      const history = historyResults[index].status === 'fulfilled' ? historyResults[index].value : [];
      
      if (main) {
        data[symbol] = {
          main: main,
          history: history
        };
        console.log(`✅ ${symbol} (${symbolCode}): Success - Value: ${main.value}, History: ${history.length} days`);
      } else {
        console.log(`❌ ${symbol} (${symbolCode}): FAILED`);
        if (result.status === 'rejected') {
          console.log(`   Error: ${result.reason}`);
        }
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
    
    // 캐시 확인 (강제 새로고침 옵션 추가)
    const forceRefresh = event.queryStringParameters && event.queryStringParameters.refresh === 'true';
    const now = Date.now();
    
    if (!forceRefresh && dataCache && lastUpdate && (now - lastUpdate) < CACHE_DURATION) {
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