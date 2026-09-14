/**
 * CeruMusic 多端同步服务插件
 *
 * 把自建部署的多端同步服务作为澜音服务插件接入。
 *
 * @name 多端同步
 * @author maiga512
 * @version 1.0.6
 * @description 连接你自建部署的同步服务器，用于歌单备份与多端同步
 */

const pluginInfo = {
  name: '多端同步',
  version: '1.0.6',
  author: 'maiga512',
  description: '连接你自建部署的同步服务器，用于歌单备份与多端同步'
}

const configSchema = [
  {
    key: 'enabled',
    label: '启用同步',
    type: 'switch',
    default: false
  },
  {
    key: 'syncMode',
    label: '同步模式',
    type: 'select',
    default: 'auto',
    options: [
      { label: '备份到云端（本地覆盖云端，不删除云端已有歌单）', value: 'backup-to-cloud' },
      { label: '从云端恢复到本地（云端合并到本地）', value: 'restore-from-cloud' },
      { label: '多端自动同步（服务器事件为准）', value: 'auto' }
    ]
  },
  {
    key: 'host',
    label: '服务器主机（只填域名）',
    type: 'text',
    required: true,
    placeholder: 'nas.example.com（不要填 http://、https:// 或路径）'
  },
  {
    key: 'port',
    label: '服务器端口',
    type: 'number',
    default: 31231,
    required: true
  },
  {
    key: 'useHttps',
    label: 'HTTPS 安全访问',
    type: 'switch',
    default: false
  },
  {
    key: 'pairCode',
    label: '登录绑定码',
    type: 'text',
    placeholder: '填写管理后台为当前用户生成的长期绑定码'
  }
]

function normalizeBaseUrl(serverUrl) {
  const raw = String(serverUrl || '').trim()
  if (!raw) return ''
  const match = raw.match(/^(https?):\/\//i)
  const explicitScheme = match ? match[1].toLowerCase() : ''
  const rest = match ? raw.slice(match[0].length) : raw
  const authority = rest.split('/')[0]
  if (!authority) return ''
  const path = rest.slice(authority.length).replace(/\/+$/, '')
  const port = Number((authority.match(/:(\d+)$/) || [])[1] || 0)
  const scheme = explicitScheme || ((port === 443 || port === 11443) ? 'https' : 'http')
  return `${scheme}://${authority.toLowerCase()}${path}`
}

function parseServerUrl(serverUrl) {
  const raw = String(serverUrl || '').trim()
  if (!raw) return null
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : 'http://' + raw)
    return {
      host: parsed.hostname,
      port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
      useHttps: parsed.protocol === 'https:',
      path: parsed.pathname.replace(/\/+$/, '')
    }
  } catch {
    return null
  }
}

function resolveBaseUrl(config) {
  if (config && config.host) {
    const host = String(config.host).trim()
    const parsedHost = parseServerUrl(host)
    if (/^https?:\/\//i.test(host) && parsedHost) {
      return `${parsedHost.useHttps ? 'https' : 'http'}://${parsedHost.host}${parsedHost.port ? ':' + parsedHost.port : ''}${parsedHost.path}`
    }
    const scheme = config.useHttps === true ? 'https' : 'http'
    const port = Number(config.port) > 0 ? Number(config.port) : 31231
    return `${scheme}://${host.replace(/\/+$/, '')}:${port}`
  }

  // 向后兼容旧配置：serverUrl 仍然可以直接使用。
  const legacy = parseServerUrl(config && config.serverUrl)
  if (!legacy) return ''
  return `${legacy.useHttps ? 'https' : 'http'}://${legacy.host}${legacy.port ? ':' + legacy.port : ''}${legacy.path}`
}

async function requestNas(config, endpoint, options) {
  const baseUrl = resolveBaseUrl(config)
  if (!baseUrl) throw new Error('请先填写同步服务器地址')

  const opts = options || {}
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
  if (opts.token !== '') {
    const token = opts.token || config.accessToken
    if (token) headers.Authorization = 'Bearer ' + token
  }

  return new Promise((resolve, reject) => {
    cerumusic.request(
      baseUrl + endpoint,
      {
        method: opts.method || 'GET',
        timeout: opts.timeout || 15000,
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined
      },
      (error, result) => {
        if (error) {
          reject(new Error(error.message || '同步服务请求失败'))
          return
        }
        if (!result) {
          reject(new Error('同步服务无响应'))
          return
        }
        if (result.statusCode < 200 || result.statusCode >= 300) {
          const message = result.body && result.body.error ? result.body.error : '同步服务请求失败'
          reject(new Error(message + '：' + result.statusCode))
          return
        }
        const body = result.body
        if (body && body.success === false) {
          reject(new Error(body.error || '同步服务请求失败'))
          return
        }
        if (body && body.success === true && Object.prototype.hasOwnProperty.call(body, 'data')) {
          resolve(body.data)
          return
        }
        resolve(body)
      }
    )
  })
}

async function testConnection(config) {
  try {
    if (!resolveBaseUrl(config)) {
      return { success: false, message: '请填写服务器地址' }
    }
    if (!config.accessToken) {
      await requestNas(config, '/health', { token: '' })
      return { success: false, message: '服务器可访问，请先登录同步服务' }
    }

    await requestNas(config, '/me')
    return { success: true, message: '同步服务已连接' }
  } catch (error) {
    return { success: false, message: error.message || '同步服务未连接' }
  }
}

module.exports = {
  pluginInfo: pluginInfo,
  pluginType: 'service',
  serviceRole: 'nas-sync',
  sources: [],
  configSchema: configSchema,
  testConnection: testConnection
}
