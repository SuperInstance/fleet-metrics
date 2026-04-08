interface MetricPoint {
  timestamp: number;
  value: number;
  labels: Record<string, string>;
}

interface HistogramBucket {
  le: number;
  count: number;
}

interface ServiceMetrics {
  requestCount: number;
  errorCount: number;
  latencyBuckets: HistogramBucket[];
  customMetrics: Map<string, MetricPoint[]>;
  lastUpdated: number;
}

interface AlertRule {
  metric: string;
  threshold: number;
  operator: 'gt' | 'lt' | 'eq';
  duration: number;
  labels?: Record<string, string>;
}

class TimeSeriesStore {
  private metrics = new Map<string, ServiceMetrics>();
  private alertRules: AlertRule[] = [];
  private readonly retentionHours = 24;
  private readonly latencyBuckets = [50, 100, 250, 500, 1000, 2500, 5000];

  record(service: string, latency: number, success: boolean, customMetrics?: Record<string, number>) {
    let serviceMetrics = this.metrics.get(service);
    if (!serviceMetrics) {
      serviceMetrics = {
        requestCount: 0,
        errorCount: 0,
        latencyBuckets: this.latencyBuckets.map(le => ({ le, count: 0 })),
        customMetrics: new Map(),
        lastUpdated: Date.now()
      };
      this.metrics.set(service, serviceMetrics);
    }

    serviceMetrics.requestCount++;
    if (!success) serviceMetrics.errorCount++;
    
    for (const bucket of serviceMetrics.latencyBuckets) {
      if (latency <= bucket.le) bucket.count++;
    }

    if (customMetrics) {
      for (const [name, value] of Object.entries(customMetrics)) {
        const points = serviceMetrics.customMetrics.get(name) || [];
        points.push({
          timestamp: Date.now(),
          value,
          labels: {}
        });
        if (points.length > 1000) points.shift();
        serviceMetrics.customMetrics.set(name, points);
      }
    }

    serviceMetrics.lastUpdated = Date.now();
    this.cleanupOldData();
  }

  private cleanupOldData() {
    const cutoff = Date.now() - (this.retentionHours * 60 * 60 * 1000);
    for (const [service, metrics] of this.metrics.entries()) {
      if (metrics.lastUpdated < cutoff) {
        this.metrics.delete(service);
      }
    }
  }

  getMetrics(service?: string) {
    if (service) {
      return this.metrics.get(service);
    }
    return Object.fromEntries(this.metrics);
  }

  getAggregatedMetrics() {
    const aggregated = {
      totalRequests: 0,
      totalErrors: 0,
      globalLatencyBuckets: this.latencyBuckets.map(le => ({ le, count: 0 })),
      services: Array.from(this.metrics.keys()),
      lastUpdated: Date.now()
    };

    for (const metrics of this.metrics.values()) {
      aggregated.totalRequests += metrics.requestCount;
      aggregated.totalErrors += metrics.errorCount;
      
      for (let i = 0; i < metrics.latencyBuckets.length; i++) {
        aggregated.globalLatencyBuckets[i].count += metrics.latencyBuckets[i].count;
      }
    }

    return aggregated;
  }

  addAlertRule(rule: AlertRule) {
    this.alertRules.push(rule);
  }

  checkAlerts() {
    const alerts = [];
    const now = Date.now();

    for (const rule of this.alertRules) {
      const metrics = this.getMetrics();
      let triggered = false;

      if (rule.metric === 'error_rate') {
        for (const [service, serviceMetrics] of Object.entries(metrics)) {
          const errorRate = serviceMetrics.errorCount / Math.max(serviceMetrics.requestCount, 1);
          if (this.evaluateRule(errorRate * 100, rule)) {
            alerts.push({
              service,
              rule,
              value: errorRate * 100,
              timestamp: now
            });
            triggered = true;
          }
        }
      }

      if (!triggered && rule.labels?.service) {
        const serviceMetrics = metrics[rule.labels.service];
        if (serviceMetrics) {
          const customMetric = serviceMetrics.customMetrics.get(rule.metric);
          if (customMetric && customMetric.length > 0) {
            const recent = customMetric.filter(p => p.timestamp > now - rule.duration);
            if (recent.length > 0) {
              const avg = recent.reduce((sum, p) => sum + p.value, 0) / recent.length;
              if (this.evaluateRule(avg, rule)) {
                alerts.push({
                  service: rule.labels.service,
                  rule,
                  value: avg,
                  timestamp: now
                });
              }
            }
          }
        }
      }
    }

    return alerts;
  }

  private evaluateRule(value: number, rule: AlertRule): boolean {
    switch (rule.operator) {
      case 'gt': return value > rule.threshold;
      case 'lt': return value < rule.threshold;
      case 'eq': return Math.abs(value - rule.threshold) < 0.001;
      default: return false;
    }
  }
}

const store = new TimeSeriesStore();

store.addAlertRule({
  metric: 'error_rate',
  threshold: 5,
  operator: 'gt',
  duration: 300000
});

store.addAlertRule({
  metric: 'response_size',
  threshold: 1048576,
  operator: 'gt',
  duration: 60000,
  labels: { service: 'api' }
});

const htmlHeaders = {
  'Content-Type': 'text/html;charset=UTF-8',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com;"
};

const jsonHeaders = {
  'Content-Type': 'application/json',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'"
};

const renderDashboard = () => {
  const metrics = store.getAggregatedMetrics();
  const alerts = store.checkAlerts();
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Fleet Metrics Dashboard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --dark: #0a0a0f;
            --darker: #050508;
            --accent: #f59e0b;
            --accent-dark: #d97706;
            --text: #f3f4f6;
            --text-secondary: #9ca3af;
            --success: #10b981;
            --warning: #f59e0b;
            --danger: #ef4444;
            --card-bg: #111117;
            --border: #1f1f2e;
        }
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            background: var(--dark);
            color: var(--text);
            line-height: 1.6;
            min-height: 100vh;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 2rem;
        }
        
        header {
            border-bottom: 1px solid var(--border);
            padding-bottom: 2rem;
            margin-bottom: 2rem;
        }
        
        .hero {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1.5rem;
        }
        
        h1 {
            font-size: 2.5rem;
            font-weight: 700;
            background: linear-gradient(135deg, var(--accent), #fbbf24);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 0.5rem;
        }
        
        .subtitle {
            color: var(--text-secondary);
            font-size: 1.1rem;
            font-weight: 400;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1.5rem;
            margin-bottom: 3rem;
        }
        
        .stat-card {
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 1.5rem;
            transition: transform 0.2s, border-color 0.2s;
        }
        
        .stat-card:hover {
            transform: translateY(-2px);
            border-color: var(--accent);
        }
        
        .stat-value {
            font-size: 2.5rem;
            font-weight: 700;
            margin-bottom: 0.5rem;
        }
        
        .stat-label {
            color: var(--text-secondary);
            font-size: 0.9rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        
        .error-rate {
            color: ${metrics.totalErrors / Math.max(metrics.totalRequests, 1) > 0.05 ? 'var(--danger)' : 'var(--success)'};
        }
        
        .alerts-section {
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 1.5rem;
            margin-bottom: 3rem;
        }
        
        .alert-item {
            display: flex;
            align-items: center;
            padding: 1rem;
            background: rgba(239, 68, 68, 0.1);
            border-left: 4px solid var(--danger);
            border-radius: 8px;
            margin-bottom: 1rem;
        }
        
        .alert-item.warning {
            background: rgba(245, 158, 11, 0.1);
            border-left-color: var(--warning);
        }
        
        .latency-histogram {
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 1.5rem;
            margin-bottom: 3rem;
        }
        
        .histogram-bars {
            display: flex;
            align-items: flex-end;
            height: 200px;
            gap: 4px;
            margin-top: 1rem;
        }
        
        .histogram-bar {
            flex: 1;
            background: linear-gradient(to top, var(--accent), var(--accent-dark));
            border-radius: 4px 4px 0 0;
            position: relative;
            min-height: 4px;
        }
        
        .bar-label {
            position: absolute;
            bottom: -25px;
            left: 0;
            right: 0;
            text-align: center;
            font-size: 0.8rem;
            color: var(--text-secondary);
        }
        
        footer {
            text-align: center;
            padding: 2rem 0;
            border-top: 1px solid var(--border);
            color: var(--text-secondary);
            font-size: 0.9rem;
        }
        
        .services-list {
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
            margin-top: 1rem;
        }
        
        .service-tag {
            background: rgba(245, 158, 11, 0.1);
            color: var(--accent);
            padding: 0.25rem 0.75rem;
            border-radius: 20px;
            font-size: 0.85rem;
            font-weight: 500;
        }
        
        @media (max-width: 768px) {
            .container {
                padding: 1rem;
            }
            
            .stats-grid {
                grid-template-columns: 1fr;
            }
            
            h1 {
                font-size: 2rem;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div class="hero">
                <div>
                    <h1>Fleet Metrics</h1>
                    <p class="subtitle">Real-time metrics collection and aggregation for the entire fleet</p>
                </div>
                <div class="timestamp">
                    Last updated: ${new Date(metrics.lastUpdated).toLocaleTimeString()}
                </div>
            </div>
            
            <div class="services-list">
                ${metrics.services.map(service => `<span class="service-tag">${service}</span>`).join('')}
            </div>
        </header>
        
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-value">${metrics.totalRequests.toLocaleString()}</div>
                <div class="stat-label">Total Requests</div>
            </div>
            
            <div class="stat-card">
                <div class="stat-value">${metrics.services.length}</div>
                <div class="stat-label">Active Services</div>
            </div>
            
            <div class="stat-card">
                <div class="stat-value error-rate">${(metrics.totalErrors / Math.max(metrics.totalRequests, 1) * 100).toFixed(2)}%</div>
                <div class="stat-label">Error Rate</div>
            </div>
            
            <div class="stat-card">
                <div class="stat-value">${alerts.length}</div>
                <div class="stat-label">Active Alerts</div>
            </div>
        </div>
        
        ${alerts.length > 0 ? `
        <section class="alerts-section">
            <h2 style="margin-bottom: 1rem; font-size: 1.5rem;">Active Alerts</h2>
            ${alerts.map(alert => `
            <div class="alert-item ${alert.rule.operator === 'gt' ? '' : 'warning'}">
                <div>
                    <strong>${alert.service}</strong>: ${alert.rule.metric} ${alert.rule.operator} ${alert.rule.threshold}
                    <br>
                    <small>Current: ${alert.value.toFixed(2)} • ${new Date(alert.timestamp).toLocaleTimeString()}</small>
                </div>
            </div>
            `).join('')}
        </section>
        ` : ''}
        
        <section class="latency-histogram">
            <h2 style="margin-bottom: 1rem; font-size: 1.5rem;">Latency Distribution (ms)</h2>
            <div class="histogram-bars">
                ${metrics.globalLatencyBuckets.map((bucket, index) => {
                    const maxCount = Math.max(...metrics.globalLatencyBuckets.map(b => b.count));
                    const height = maxCount > 0 ? (bucket.count / maxCount * 100) : 0;
                    return `
                    <div class="histogram-bar" style="height: ${height}%">
                        <div class="bar-label">
                            ≤${bucket.le}ms<br>
                            <small>${bucket.count}</small>
                        </div>
                    </div>
                    `;
                }).join('')}
            </div>
        </section>
        
        <footer>
            <p>Fleet Metrics Dashboard • Real-time monitoring and alerting</p>
            <p style="margin-top: 0.5rem; font-size: 0.8rem; opacity: 0.7;">
                Endpoints: POST /api/record • GET /api/metrics • GET /api/dashboards • GET /health
            </p>
        </footer>
    </div>
    
    <script>
        setTimeout(() => location.reload(), 10000);
        
        document.addEventListener('DOMContentLoaded', () => {
            const cards = document.querySelectorAll('.stat-card');
            cards.forEach(card => {
                card.addEventListener('click', () => {
                    card.style.transform = 'scale(0.98)';
                    setTimeout(() => {
                        card.style.transform = '';
                    }, 150);
                });
            });
        });
    </script>
</body>
</html>`;
};

const handleRequest = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    if (path === '/health') {
      return new Response('OK', { status: 200 });
    }

    if (path === '/api/record' && request.method === 'POST') {
      const data = await request.json() as {
        service: string;
        latency: number;
        success: boolean;
        metrics?: Record<string, number>;
      };

      if (!data.service || typeof data.latency !== 'number') {
        return new Response(JSON.stringify({ error: 'Invalid data' }), {
          status: 400,
          headers: jsonHeaders
        });
      }

      store.record(data.service, data.latency, data.success, data.metrics);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: jsonHeaders
      });
    }

    if (path === '/api/metrics') {
      const service = url.searchParams.get('service');
      const metrics = service ? store.getMetrics(service) : store.getAggregatedMetrics();
      
      if (!metrics && service) {
        return new Response(JSON.stringify({ error: 'Service not found' }), {
          status: 404,
          headers: jsonHeaders
        });
      }

      return new Response(JSON.stringify(metrics), {
        status: 200,
        headers: jsonHeaders
      });
    }

    if (path === '/api/dashboards' || path === '/') {
      return new Response(renderDashboard(), {
        status: 200,
        headers: htmlHeaders
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: jsonHeaders
    });

  } catch (error) {
    console.error('Error handling request:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: jsonHeaders
    });
  }
};

export default {
  async fetch(request: Request): Promise<Response> {
    return handleRequest(request);
  }
};