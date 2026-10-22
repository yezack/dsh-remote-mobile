import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { getLoginPageHtml } from '../lib/routes/login-page.js'

const DUMMY_PEM = '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----'

/** 取出授权页里的内联脚本源码 */
function extractInlineScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
}

/**
 * 在最小假浏览器里跑一遍授权页脚本，返回 verifyApiUrl / successRedirectUrl。
 * 直接在脚本尾部追加一行导出，因为这两个常量原本是脚本作用域内的 const。
 */
function runLoginPageScript({ html, pathname, search = '', baseURI = '', hasBaseTag = false }) {
  const src = extractInlineScripts(html)[0]
  const elements = new Map()
  const makeEl = (id = 'anon') => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: '',
        className: '',
        innerText: '',
        style: {},
        disabled: false,
        addEventListener() {},
      })
    }
    return elements.get(id)
  }
  const sandbox = {
    window: {
      location: { pathname, search, origin: 'http://192.168.1.5:3080', href: '' },
      cancelAnimationFrame() {},
    },
    document: {
      baseURI,
      querySelector: (sel) => (hasBaseTag && sel === 'base' ? {} : null),
      getElementById: (id) => makeEl(id),
    },
    URL,
    URLSearchParams,
    TextEncoder,
    console,
    setTimeout,
    fetch: async () => ({ json: async () => ({ success: false }) }),
  }
  vm.createContext(sandbox)
  vm.runInContext(
    `${src}\n;globalThis.__probe = { verifyApiUrl, successRedirectUrl, doVerify };`,
    sandbox,
  )
  return { ...sandbox.__probe, elements }
}

// ─────────────────────────────────────────────────────────────────────────────
// 回归：授权页内联脚本必须能被浏览器解析。
// 历史 bug：源码写在模板字符串里，正则 /\/auth\/?$/ 中的 \/ 在字符串求值时
// 退化成 /，生成 //auth/?$/ —— `//` 是行注释，整个 <script> 抛 SyntaxError，
// 提交按钮再也挂不上 submit 回调，表现为"授权页点什么都没反应、无法登录"。
// ─────────────────────────────────────────────────────────────────────────────
test('授权页内联脚本可编译（无被模板字符串吞掉的反斜杠）', () => {
  const html = getLoginPageHtml(DUMMY_PEM)
  const scripts = extractInlineScripts(html)
  assert.ok(scripts.length > 0, '授权页应包含内联脚本')

  for (const [i, src] of scripts.entries()) {
    assert.doesNotThrow(
      () => new Function(src),
      `内联脚本 #${i + 1} 必须能通过解析，否则登录按钮不会绑定任何行为`,
    )
  }

  // 1.10.0 起采纳上游写法：new RegExp('/auth/?$') —— 构造参数是普通字符串、不含
  // 反斜杠，从根上规避模板字符串把转义折叠掉；同时不得出现折叠后的 //auth 行注释。
  assert.ok(
    html.includes("new RegExp('/auth/?$')"),
    "应使用 new RegExp('/auth/?$') 显式构造，避免模板字符串转义折叠",
  )
  assert.ok(!html.includes('replace(//auth'), '不得出现 replace(//auth 形式（会变成行注释）')
})

test('verifyApiUrl 在网关子路径下保持在子路径内', () => {
  const html = getLoginPageHtml(DUMMY_PEM)

  // 直连默认端口，URL 形如 /auth/ 或 /auth
  for (const pathname of ['/auth/', '/auth']) {
    const { verifyApiUrl } = runLoginPageScript({ html, pathname })
    assert.equal(verifyApiUrl, 'http://192.168.1.5:3080/api/remote-mobile/verify', `pathname=${pathname}`)
  }

  // 反代子路径（如 http://ip:5666/app/dsh/auth/）
  for (const pathname of ['/app/dsh/auth/', '/app/dsh/auth']) {
    const { verifyApiUrl } = runLoginPageScript({ html, pathname })
    assert.equal(verifyApiUrl, 'http://192.168.1.5:3080/app/dsh/api/remote-mobile/verify', `pathname=${pathname}`)
  }

  // 页面带 <base href> 时优先按 baseURI 解析
  const { verifyApiUrl } = runLoginPageScript({
    html,
    pathname: '/app/dsh/auth/',
    baseURI: 'http://192.168.1.5:3080/app/dsh/',
    hasBaseTag: true,
  })
  assert.equal(verifyApiUrl, 'http://192.168.1.5:3080/app/dsh/api/remote-mobile/verify')
})

test('successRedirectUrl 登录后不跳出网关子路径', () => {
  const html = getLoginPageHtml(DUMMY_PEM)

  assert.equal(
    runLoginPageScript({ html, pathname: '/auth' }).successRedirectUrl,
    'http://192.168.1.5:3080/',
  )
  assert.equal(
    runLoginPageScript({ html, pathname: '/app/dsh/auth' }).successRedirectUrl,
    'http://192.168.1.5:3080/app/dsh/',
  )
  assert.equal(
    runLoginPageScript({ html, pathname: '/app/dsh/auth/' }).successRedirectUrl,
    'http://192.168.1.5:3080/app/dsh/',
  )

  // ?redirect= 携带站内路径时保持在前缀内
  assert.equal(
    runLoginPageScript({ html, pathname: '/app/dsh/auth/', search: '?redirect=/app/dsh/workspaces' }).successRedirectUrl,
    'http://192.168.1.5:3080/app/dsh/workspaces',
  )

  // 页面带 <base href> 时回到 base 目录
  assert.equal(
    runLoginPageScript({
      html,
      pathname: '/app/dsh/auth/',
      baseURI: 'http://192.168.1.5:3080/app/dsh/',
      hasBaseTag: true,
    }).successRedirectUrl,
    'http://192.168.1.5:3080/app/dsh/',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// 回归：内联脚本不得引用仅在服务端存在的标识符。
// 历史 bug：失败分支的回退文案写成裸 isEn（忘了插值），浏览器求值即抛
// ReferenceError，被外层 catch 吞掉后把真实原因显示成「网络连接异常」。
// ─────────────────────────────────────────────────────────────────────────────
test('内联脚本不得残留服务端标识符，且失败回退文案可用', async () => {
  const html = getLoginPageHtml(DUMMY_PEM)
  const script = extractInlineScripts(html)[0]

  for (const name of ['isEn', 'i18n', 'inlinePublicKey', 'publicKeyPem', 'lang']) {
    assert.ok(
      !new RegExp(`\\b${name}\\b`).test(script),
      `内联脚本不得残留仅在服务端存在的标识符 ${name}（应改用 \${JSON.stringify(...)} 插值）`,
    )
  }
  assert.ok(script.includes(JSON.stringify('授权失败，请重试')), '失败回退文案应以插值形式内联')

  // 服务端返回 { success: false } 但缺 reason 时：显示本地化回退文案，而不是网络错误
  const { doVerify, elements } = runLoginPageScript({ html, pathname: '/app/dsh/auth/' })
  await doVerify('123456')
  const statusMsg = elements.get('statusMsg')
  assert.equal(statusMsg.innerText, '授权失败，请重试')
  assert.equal(statusMsg.className, 'status-msg error')
  assert.equal(elements.get('submitBtn').disabled, false, '失败后按钮必须恢复可点击')

  // 英文页同样走插值后的英文回退文案（这正是原先 isEn 想表达的分支）
  const en = getLoginPageHtml(DUMMY_PEM, 'en')
  const enRun = runLoginPageScript({ html: en, pathname: '/auth' })
  await enRun.doVerify('123456')
  assert.equal(enRun.elements.get('statusMsg').innerText, 'Authorization failed, please try again')
})
