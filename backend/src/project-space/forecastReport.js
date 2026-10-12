export function renderForecastReport(forecast = {}) {
  const json = JSON.stringify({
    version: forecast.version || '1.0',
    generatedAt: forecast.generatedAt || null,
    subject: forecast.subject || {},
    keyCruxes: forecast.keyCruxes || [],
    signposts: forecast.signposts || [],
    nextFourQuarters: forecast.nextFourQuarters || {},
    fiveYear: forecast.fiveYear || {},
    scenarios: forecast.scenarios || [],
    dataQuality: forecast.dataQuality || {},
  }, null, 2);
  return `# forecast_report\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}
