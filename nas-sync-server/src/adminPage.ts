export const renderAdminPage = () => `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>树夏Music 同步管理</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0f1211;
        --panel: #181d1a;
        --panel-2: #202720;
        --line: #303933;
        --text: #f3f6f3;
        --muted: #a7b0aa;
        --subtle: #78827b;
        --green: #17a86b;
        --green-2: #108252;
        --red: #d85a5a;
        --yellow: #d7b85a;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family:
          -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei",
          sans-serif;
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background:
          radial-gradient(circle at 18% 12%, rgba(23, 168, 107, 0.12), transparent 28%),
          radial-gradient(circle at 82% 78%, rgba(120, 130, 123, 0.1), transparent 30%);
      }

      button,
      input {
        font: inherit;
      }

      button {
        min-height: 40px;
        border: 1px solid var(--line);
        border-radius: 7px;
        padding: 0 14px;
        background: var(--panel-2);
        color: var(--text);
        cursor: pointer;
      }

      button:hover {
        border-color: #536159;
      }

      button.primary {
        border-color: var(--green);
        background: var(--green);
        color: #fff;
      }

      button.primary:hover {
        background: var(--green-2);
      }

      button[disabled] {
        cursor: not-allowed;
        opacity: 0.55;
      }

      input {
        width: 100%;
        height: 44px;
        border: 1px solid var(--line);
        border-radius: 7px;
        padding: 0 12px;
        background: #101411;
        color: var(--text);
      }

      input:focus {
        outline: 2px solid rgba(23, 168, 107, 0.35);
        border-color: var(--green);
      }

      .password-field {
        display: grid;
        grid-template-columns: 1fr auto;
        align-items: center;
        gap: 8px;
      }

      .password-field input {
        min-width: 0;
      }

      .password-field button {
        width: 44px;
        min-width: 44px;
        padding: 0;
        color: var(--muted);
      }

      .password-field button svg {
        width: 18px;
        height: 18px;
        display: block;
        margin: 0 auto;
      }

      label {
        display: block;
        margin: 14px 0 7px;
        color: var(--muted);
        font-size: 13px;
      }

      h1,
      h2,
      p {
        margin: 0;
      }

      h1 {
        font-size: clamp(30px, 5vw, 54px);
        line-height: 1.05;
      }

      h2 {
        font-size: 18px;
      }

      p {
        color: var(--muted);
        line-height: 1.65;
      }

      .mono {
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      }

      .hint {
        color: var(--subtle);
        font-size: 13px;
      }

      .login-screen {
        position: relative;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
      }

      .login-card {
        width: min(420px, 100%);
        border: 1px solid var(--line);
        border-radius: 10px;
        background: rgba(24, 29, 26, 0.96);
        padding: 28px;
        box-shadow: 0 28px 80px rgba(0, 0, 0, 0.32);
      }

      .login-card h1 {
        font-size: 28px;
        margin-bottom: 10px;
      }

      .login-card .primary {
        width: 100%;
        margin-top: 18px;
      }

      .app-shell {
        position: relative;
        width: min(1240px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 30px 0 44px;
      }

      header {
        display: grid;
        grid-template-columns: 1fr auto;
        align-items: end;
        gap: 20px;
        margin-bottom: 22px;
      }

      .top-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 38px;
        padding: 0 12px;
        border: 1px solid var(--line);
        border-radius: 7px;
        color: var(--muted);
        background: rgba(24, 29, 26, 0.86);
      }

      .dot {
        width: 8px;
        height: 8px;
        border-radius: 99px;
        background: var(--yellow);
      }

      .dot.ok {
        background: var(--green);
      }

      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 340px;
        gap: 16px;
      }

      section {
        border: 1px solid var(--line);
        border-radius: 9px;
        background: rgba(24, 29, 26, 0.94);
        padding: 18px;
      }

      .section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
      }

      .stack {
        display: grid;
        gap: 16px;
      }

      .row {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      .server {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        margin-top: 12px;
      }

      .codebox {
        min-height: 42px;
        display: flex;
        align-items: center;
        overflow: auto;
        white-space: nowrap;
        border: 1px solid var(--line);
        border-radius: 7px;
        padding: 0 12px;
        background: #101411;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th,
      td {
        padding: 13px 10px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: middle;
      }

      th {
        color: var(--muted);
        font-size: 12px;
        font-weight: 600;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        min-height: 27px;
        padding: 0 9px;
        border: 1px solid var(--line);
        border-radius: 999px;
        color: var(--muted);
        background: #141916;
        font-size: 12px;
      }

      .empty {
        min-height: 180px;
        display: grid;
        place-items: center;
        color: var(--subtle);
        border: 1px dashed var(--line);
        border-radius: 8px;
      }

      .details-panel {
        display: none;
      }

      .details-modal {
        position: fixed;
        inset: 0;
        z-index: 20;
        display: grid;
        place-items: center;
        padding: 24px;
        background: rgba(4, 7, 5, 0.72);
      }

      .details-modal[hidden] {
        display: none;
      }

      .details-dialog {
        width: min(980px, 100%);
        max-height: min(820px, calc(100vh - 48px));
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: #171c19;
        box-shadow: 0 28px 100px rgba(0, 0, 0, 0.5);
      }

      .details-dialog-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 18px 22px;
        border-bottom: 1px solid var(--line);
      }

      .details-dialog-body {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
        padding: 18px 22px 24px;
        overflow: auto;
        max-height: calc(min(820px, 100vh - 48px) - 76px);
      }

      .detail-group {
        min-width: 0;
        border: 1px solid var(--line);
        border-radius: 9px;
        background: #101411;
        overflow: hidden;
      }

      .detail-group h3 {
        margin: 0;
        padding: 12px 14px;
        border-bottom: 1px solid var(--line);
        color: var(--text);
        font-size: 14px;
      }

      .detail-list {
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .detail-list li {
        display: grid;
        grid-template-columns: 34px minmax(0, 1fr);
        gap: 8px;
        padding: 9px 14px;
        border-bottom: 1px solid rgba(55, 67, 59, 0.55);
        color: var(--muted);
        font-size: 13px;
      }

      .detail-list li:last-child {
        border-bottom: 0;
      }

      .detail-index {
        color: var(--subtle);
        font-variant-numeric: tabular-nums;
      }

      .detail-empty {
        padding: 14px;
        color: var(--subtle);
        font-size: 13px;
      }

      @media (max-width: 700px) {
        .details-modal {
          padding: 10px;
        }

        .details-dialog-body {
          grid-template-columns: 1fr;
          padding: 12px;
        }
      }

      .toast {
        position: fixed;
        right: 20px;
        bottom: 20px;
        max-width: min(420px, calc(100vw - 40px));
        padding: 12px 14px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #0f1210;
        color: var(--text);
        box-shadow: 0 16px 50px rgba(0, 0, 0, 0.35);
        opacity: 0;
        transform: translateY(8px);
        pointer-events: none;
        transition:
          opacity 0.16s ease,
          transform 0.16s ease;
      }

      .toast.show {
        opacity: 1;
        transform: translateY(0);
      }

      .error {
        color: var(--red);
      }

      [hidden] {
        display: none !important;
      }

      @media (max-width: 900px) {
        header,
        .layout {
          grid-template-columns: 1fr;
        }

        .top-actions {
          justify-content: flex-start;
        }

        table,
        thead,
        tbody,
        tr,
        th,
        td {
          display: block;
        }

        thead {
          display: none;
        }

        tr {
          border: 1px solid var(--line);
          border-radius: 8px;
          padding: 10px;
          margin-bottom: 10px;
          background: #151a17;
        }

        td {
          border-bottom: 0;
          padding: 7px 0;
        }

        td::before {
          content: attr(data-label);
          display: block;
          color: var(--subtle);
          font-size: 12px;
          margin-bottom: 4px;
        }
      }
    </style>
  </head>
  <body>
    <main id="loginScreen" class="login-screen">
      <section class="login-card">
        <h1>树夏Music 同步管理</h1>
        <p id="loginHint">请先登录 NAS 同步服务器管理后台。</p>
        <label for="adminUsername">管理员账号</label>
        <input id="adminUsername" class="mono" autocomplete="username" />
        <label for="adminPassword">管理员密码</label>
        <div class="password-field">
          <input id="adminPassword" type="password" autocomplete="current-password" />
          <button type="button" data-toggle-password="adminPassword" aria-label="显示密码" title="显示/隐藏密码"></button>
        </div>
        <button id="loginAdmin" class="primary">登录</button>
        <p id="defaultHint" class="hint" style="margin-top: 14px" hidden>首次部署默认账号为 <span class="mono">admin</span>，默认密码为 <span class="mono">password</span>。登录后请修改默认账号或密码。</p>
      </section>
    </main>

    <main id="appShell" class="app-shell" hidden>
      <header>
        <div>
          <h1>树夏Music 同步管理</h1>
          <p>这是部署在 NAS 上的同步服务器。所有用户共用服务器地址，但每个用户用自己的绑定码登录，数据按账号独立保存。</p>
        </div>
        <div class="top-actions">
          <div class="status"><span id="statusDot" class="dot"></span><span id="statusText">检查中</span></div>
          <button id="logoutAdmin">退出登录</button>
        </div>
      </header>

      <div class="layout">
        <section>
          <div class="section-head">
            <h2>用户与绑定码</h2>
            <button id="reloadUsers">刷新</button>
          </div>
          <div id="usersEmpty" class="empty">暂无用户，先创建一个用户</div>
          <table id="usersTable" hidden>
            <thead>
              <tr>
                <th>用户</th>
                <th>数据</th>
                <th>同步</th>
                <th>绑定码</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="usersBody"></tbody>
          </table>
        </section>

        <div class="stack">
          <section>
            <h2>新建用户</h2>
            <label for="username">用户名</label>
            <input id="username" autocomplete="off" placeholder="例如 user1" />
            <button id="createUser" class="primary" style="width: 100%; margin-top: 14px">创建用户</button>
            <p class="hint" style="margin-top: 10px">每个用户创建后都是空数据，不会看到其他人的歌单。</p>
          </section>

          <section>
            <h2>插件配置</h2>
            <p class="hint" style="margin-top: 8px">所有用户填同一个服务器地址；绑定码按用户单独生成。</p>
            <div class="server">
              <div id="serverUrl" class="codebox mono"></div>
              <button data-copy-target="serverUrl">复制</button>
            </div>
          </section>

          <section>
            <h2>修改管理员用户名</h2>
            <label for="newAdminUsername">新管理员用户名</label>
            <input id="newAdminUsername" autocomplete="username" />
            <button id="changeAdminUsername" class="primary" style="width: 100%; margin-top: 14px">保存用户名</button>
          </section>

          <section>
            <h2>修改管理员密码</h2>
            <label for="oldAdminPassword">旧密码</label>
            <div class="password-field">
              <input id="oldAdminPassword" type="password" autocomplete="current-password" />
              <button type="button" data-toggle-password="oldAdminPassword" aria-label="显示密码" title="显示/隐藏密码"></button>
            </div>
            <label for="newAdminPassword">新密码</label>
            <div class="password-field">
              <input id="newAdminPassword" type="password" autocomplete="new-password" placeholder="至少 6 位" />
              <button type="button" data-toggle-password="newAdminPassword" aria-label="显示密码" title="显示/隐藏密码"></button>
            </div>
            <label for="confirmAdminPassword">确认新密码</label>
            <div class="password-field">
              <input id="confirmAdminPassword" type="password" autocomplete="new-password" placeholder="再输入一次新密码" />
              <button type="button" data-toggle-password="confirmAdminPassword" aria-label="显示密码" title="显示/隐藏密码"></button>
            </div>
            <button id="changeAdminPassword" class="primary" style="width: 100%; margin-top: 14px">保存新密码</button>
          </section>
        </div>
      </div>
    </main>

    <div id="detailsModal" class="details-modal" hidden>
      <section class="details-dialog" role="dialog" aria-modal="true" aria-labelledby="detailsTitle">
        <div class="details-dialog-head">
          <div>
            <h2 id="detailsTitle">同步数据详情</h2>
            <p id="detailsSubtitle" class="hint" style="margin-top: 5px"></p>
          </div>
          <button id="closeDetails" type="button">关闭</button>
        </div>
        <div id="detailsBody" class="details-dialog-body"></div>
      </section>
    </div>

    <div id="toast" class="toast"></div>

    <script>
      const eyeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
      const eyeOffIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 3 18 18"/><path d="M10.7 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a18.4 18.4 0 0 1-3.1 4.1"/><path d="M6.6 6.6C3.7 8.5 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 4.3-1"/><path d="M9.9 9.9A3 3 0 0 0 14.1 14.1"/></svg>';
      const state = {
        users: [],
        adminToken: localStorage.getItem('shuxia.sync.adminToken') || '',
        adminUsername: 'admin',
      };

      const $ = (id) => document.getElementById(id);
      const usersTable = $('usersTable');
      const usersEmpty = $('usersEmpty');
      const usersBody = $('usersBody');
      const toast = $('toast');
      const detailsModal = $('detailsModal');
      const detailsBody = $('detailsBody');
      const detailsTitle = $('detailsTitle');
      const detailsSubtitle = $('detailsSubtitle');

      $('serverUrl').textContent = location.origin;

      const togglePasswordVisibility = (event) => {
        const rawTarget = event.target;
        if (!(rawTarget instanceof HTMLElement)) return;

        const target = rawTarget.closest('button[data-toggle-password]');
        if (!(target instanceof HTMLElement)) return;
        event.preventDefault();
        const inputId = target.dataset.togglePassword;
        if (!inputId) return;

        const input = $(inputId);
        if (!(input instanceof HTMLInputElement)) return;

        const visible = input.type === 'text';
        input.type = visible ? 'password' : 'text';
        target.innerHTML = visible ? eyeIcon : eyeOffIcon;
        target.setAttribute('aria-label', visible ? '显示密码' : '隐藏密码');
        input.focus();
      };

      document.addEventListener('pointerdown', togglePasswordVisibility);

      document.querySelectorAll('[data-toggle-password]').forEach((button) => {
        button.innerHTML = eyeIcon;
        button.setAttribute('aria-label', '显示密码');
        button.setAttribute('title', '显示/隐藏密码');
      });

      const showToast = (message, isError = false) => {
        toast.textContent = message;
        toast.classList.toggle('error', isError);
        toast.classList.add('show');
        window.clearTimeout(showToast.timer);
        showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2800);
      };

      const setView = (view) => {
        $('loginScreen').hidden = view !== 'login';
        $('appShell').hidden = view !== 'app';
      };

      const loadBootstrap = async () => {
        try {
          const data = await fetch('/admin/bootstrap').then((res) => res.json());
          const admin = data.admin || {};
          state.adminUsername = admin.username || 'admin';
          $('adminUsername').value = state.adminUsername;
          $('newAdminUsername').value = state.adminUsername;
          $('defaultHint').hidden = !admin.defaultAccount;
          $('adminPassword').placeholder = admin.defaultAccount ? 'password' : '';
        } catch {
          $('adminUsername').value = state.adminUsername;
        }
      };

      const request = async (path, options = {}) => {
        const response = await fetch(path, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            Authorization: state.adminToken ? 'Bearer ' + state.adminToken : '',
            ...(options.headers || {}),
          },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '请求失败');
        return data;
      };

      const escapeHtml = (value) =>
        String(value ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');

      const renderUsers = () => {
        usersBody.innerHTML = '';
        usersTable.hidden = state.users.length === 0;
        usersEmpty.hidden = state.users.length > 0;

        for (const user of state.users) {
          const bindingCode = user.bindingCode || '';
          const hasBindingCode = Boolean(bindingCode || user.hasBindingCode);
          const tr = document.createElement('tr');
          tr.innerHTML =
            '<td data-label="用户">' +
            '<strong>' +
            escapeHtml(user.username) +
            '</strong><div class="hint mono">' +
            escapeHtml(user.id) +
            '</div></td>' +
            '<td data-label="数据">' +
            '<span class="pill">' +
            (user.playlistCount || 0) +
            ' 歌单</span> <span class="pill">' +
            (user.songCount || 0) +
            ' 歌曲</span> <span class="pill">' +
            (user.favoriteCount || 0) +
            ' 收藏</span></td>' +
            '<td data-label="同步"><div>Revision ' +
            (user.revision || 0) +
            '</div><div class="hint">' +
            (user.activeSessionCount || 0) +
            ' 个已登录设备</div></td>' +
            '<td data-label="绑定码"><div id="pair-' +
            user.id +
            '" class="codebox mono">' +
            (bindingCode ? escapeHtml(bindingCode) : '未生成') +
            '</div></td>' +
            '<td data-label="操作"><div class="row"><button data-pair="' +
            user.id +
            '">' +
            (hasBindingCode ? '重新生成' : '生成绑定码') +
            '</button><button data-copy-target="pair-' +
            user.id +
            '">复制</button><button data-details="' +
            user.id +
            '">查看详情</button><button class="danger" data-delete-user="' +
            user.id +
            '" data-delete-username="' +
            escapeHtml(user.username) +
            '">删除</button></div></td>';
          usersBody.appendChild(tr);
        }
      };

      const refreshStatus = async () => {
        try {
          const data = await fetch('/health').then((res) => res.json());
          $('statusDot').classList.toggle('ok', data.status === 'ok');
          $('statusText').textContent = data.status === 'ok' ? '服务在线' : '服务异常';
        } catch {
          $('statusDot').classList.remove('ok');
          $('statusText').textContent = '服务不可达';
        }
      };

      const loadDashboard = async () => {
        if (!state.adminToken) {
          setView('login');
          return;
        }

        const data = await request('/admin/status');
        state.users = data.users || [];
        if (data.admin?.username) {
          state.adminUsername = data.admin.username;
          $('adminUsername').value = data.admin.username;
          $('newAdminUsername').value = data.admin.username;
        }
        renderUsers();
        setView('app');
        refreshStatus();
      };

      $('loginAdmin').addEventListener('click', async () => {
        try {
          const response = await fetch('/admin/login', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              username: $('adminUsername').value.trim(),
              password: $('adminPassword').value,
            }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || '登录失败');

          state.adminToken = data.accessToken;
          localStorage.setItem('shuxia.sync.adminToken', state.adminToken);
          $('adminPassword').value = '';
          await loadDashboard();
          showToast(data.admin?.defaultAccount ? '已登录，请尽快修改默认账号或密码' : '已登录');
        } catch (error) {
          showToast(error.message, true);
        }
      });

      $('adminPassword').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') $('loginAdmin').click();
      });

      $('logoutAdmin').addEventListener('click', () => {
        state.adminToken = '';
        localStorage.removeItem('shuxia.sync.adminToken');
        state.users = [];
        renderUsers();
        setView('login');
        showToast('已退出登录');
      });

      $('changeAdminUsername').addEventListener('click', async () => {
        try {
          const username = $('newAdminUsername').value.trim();
          if (!username) throw new Error('请输入新管理员用户名');
          const data = await request('/admin/change-username', {
            method: 'POST',
            body: JSON.stringify({username}),
          });
          state.adminUsername = data.admin?.username || username;
          $('adminUsername').value = state.adminUsername;
          $('newAdminUsername').value = state.adminUsername;
          const check = await fetch('/admin/bootstrap').then((res) => res.json());
          if (check.admin?.username !== state.adminUsername) {
            throw new Error('用户名已提交，但读取验证失败，请刷新后重试');
          }
          showToast('管理员用户名已修改并验证');
        } catch (error) {
          showToast(error.message, true);
        }
      });

      $('changeAdminPassword').addEventListener('click', async () => {
        try {
          const oldPassword = $('oldAdminPassword').value;
          const newPassword = $('newAdminPassword').value;
          const confirmPassword = $('confirmAdminPassword').value;

          if (newPassword !== confirmPassword) {
            throw new Error('两次输入的新密码不一致');
          }

          await request('/admin/change-password', {
            method: 'POST',
            body: JSON.stringify({
              oldPassword,
              newPassword,
            }),
          });
          $('oldAdminPassword').value = '';
          $('newAdminPassword').value = '';
          $('confirmAdminPassword').value = '';
          state.adminToken = '';
          state.users = [];
          localStorage.removeItem('shuxia.sync.adminToken');
          renderUsers();
          setView('login');
          $('adminUsername').value = state.adminUsername;
          $('adminPassword').value = '';
          showToast('管理员密码已修改，请重新登录');
        } catch (error) {
          showToast(error.message, true);
        }
      });

      $('reloadUsers').addEventListener('click', async () => {
        try {
          await loadDashboard();
          showToast('已刷新');
        } catch (error) {
          showToast(error.message, true);
        }
      });

      $('createUser').addEventListener('click', async () => {
        try {
          const body = {
            username: $('username').value.trim(),
          };
          if (!body.username) throw new Error('请输入用户名');
          await request('/admin/users', {
            method: 'POST',
            body: JSON.stringify(body),
          });
          $('username').value = '';
          await loadDashboard();
          showToast('用户已创建');
        } catch (error) {
          showToast(error.message, true);
        }
      });

      document.addEventListener('click', async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;

        const pairUserId = target.dataset.pair;
        if (pairUserId) {
          try {
            const data = await request('/admin/pair-codes', {
              method: 'POST',
              body: JSON.stringify({userId: pairUserId, force: Boolean(target.textContent?.includes('重新'))}),
            });
            const box = $('pair-' + pairUserId);
            box.textContent = data.pairCode;
            target.textContent = '重新生成';
            showToast(data.existing ? '绑定码已存在' : '新绑定码已生成');
          } catch (error) {
            showToast(error.message, true);
          }
          return;
        }

        const detailsUserId = target.dataset.details;
        if (detailsUserId) {
          detailsModal.hidden = false;
          detailsBody.innerHTML = '<div class="detail-empty">正在读取云端详情…</div>';
          detailsTitle.textContent = '同步数据详情';
          detailsSubtitle.textContent = '正在读取用户数据';
          try {
            const data = await request('/admin/user-details?userId=' + encodeURIComponent(detailsUserId));
            detailsTitle.textContent = '同步数据详情';
            detailsSubtitle.textContent = (data.user?.username || detailsUserId) + ' · 只读查看';
            const group = (title, items, label) => {
              const values = items || [];
              const rows = values.map((item, index) => '<li><span class="detail-index">' + (index + 1) + '</span><span>' + label(item) + '</span></li>').join('');
              return '<section class="detail-group"><h3>' + title + '（' + values.length + '）</h3>' + (rows ? '<ol class="detail-list">' + rows + '</ol>' : '<div class="detail-empty">暂无内容</div>') + '</section>';
            };
            const playlists = data.playlists || [];
            const playlistRows = playlists.map((playlist) => {
              const songs = playlist.songs || [];
              return '<li><span class="detail-index">' + (Number(playlist.position || 0) + 1) + '</span><span><strong>' + escapeHtml(playlist.name || playlist.id || '未命名') + '</strong><br><span class="hint">' + songs.length + ' 首歌曲</span></span></li>';
            }).join('');
            detailsBody.innerHTML =
              '<section class="detail-group"><h3>歌单（' + playlists.length + '）</h3>' + (playlistRows ? '<ol class="detail-list">' + playlistRows + '</ol>' : '<div class="detail-empty">暂无歌单</div>') + '</section>' +
              group('插件', data.plugins, (item) => escapeHtml(item.name || item.identityKey || '未命名插件')) +
              group('歌曲收藏', data.favorites, (item) => escapeHtml(item.title || item.name || item.entityId || '未命名收藏')) +
              group('播客收藏', data.podcasts, (item) => escapeHtml(item.title || item.name || item.entityId || '未命名播客'));
          } catch (error) {
            detailsBody.innerHTML = '<div class="detail-empty error">' + escapeHtml(error.message || '读取详情失败') + '</div>';
          }
          return;
        }

        const deleteUserId = target.dataset.deleteUser;
        if (deleteUserId) {
          const username = target.dataset.deleteUsername || deleteUserId;
          const confirmText = window.prompt(
            '删除用户“' +
              username +
              '”会删除这个用户的绑定码、登录设备、歌单、歌曲、收藏和同步记录。请输入“我要删除”确认删除。'
          );
          if (confirmText !== '我要删除') {
            showToast('已取消删除');
            return;
          }

          try {
            await request('/admin/users', {
              method: 'DELETE',
              body: JSON.stringify({userId: deleteUserId, confirmText}),
            });
            await loadDashboard();
            showToast('用户已删除');
          } catch (error) {
            showToast(error.message, true);
          }
          return;
        }

        const copyTarget = target.dataset.copyTarget;
        if (copyTarget) {
          const text = $(copyTarget)?.textContent?.trim() || '';
          if (!text || text === '未生成') {
            showToast('没有可复制的内容', true);
            return;
          }
          try {
            await navigator.clipboard.writeText(text);
          } catch {
            const input = document.createElement('textarea');
            input.value = text;
            input.style.position = 'fixed';
            input.style.left = '-9999px';
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            input.remove();
          }
          showToast('已复制');
        }
      });

      $('closeDetails').addEventListener('click', () => {
        detailsModal.hidden = true;
      });

      detailsModal.addEventListener('click', (event) => {
        if (event.target === detailsModal) detailsModal.hidden = true;
      });

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') detailsModal.hidden = true;
      });

      setView('login');
      loadBootstrap();
      loadDashboard().catch(() => {
        state.adminToken = '';
        localStorage.removeItem('shuxia.sync.adminToken');
        setView('login');
      });
    </script>
  </body>
</html>`;
