/* ==========================================================================
   ezyt — авторизация через Supabase (реальная база данных).
   Регистрация — ник + email + пароль. Вход — по нику ИЛИ по email (одно
   поле, распознаём автоматически по "@") + пароль. Для самого Supabase
   Auth используется отдельный служебный email на основе ника
   (см. authEmailFor) — так письма подтверждения никогда не шлются на
   настоящий адрес и не расходуют лимит.
   ========================================================================== */

window.Auth = (function () {
  'use strict';

  // Supabase Auth привязан к email, но у нас логин по нику — поэтому у каждого
  // аккаунта два email: служебный (ник + этот домен, только для входа) и
  // настоящий, который пользователь вводит при регистрации и который лежит
  // приватно в profiles (виден только самому владельцу через RLS).
  const AUTH_EMAIL_DOMAIN = '@ezyt-users.app';
  let cachedUser = null; // { id, username, email }

  function authEmailFor(username) { return username.trim().toLowerCase() + AUTH_EMAIL_DOMAIN; }

  function validateUsername(username) {
    if (!username || username.trim().length < 2) return 'Ник — минимум 2 символа';
    return null;
  }
  function validateEmail(email) {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Введи корректный email';
    return null;
  }
  function validatePassword(password) {
    if (!password || password.length < 6) return 'Пароль — минимум 6 символов';
    return null;
  }

  async function fetchProfile(id) {
    const { data, error } = await sb.from('profiles').select('username, email').eq('id', id).single();
    if (error || !data) return null;
    return data;
  }

  // остальной код (index.html/app.js) может дождаться Auth.ready перед
  // тем, как читать Auth.currentUser() — восстановление сессии асинхронно
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  async function restoreSession() {
    try {
      const { data } = await sb.auth.getSession();
      const session = data && data.session;
      if (session && session.user) {
        const profile = await fetchProfile(session.user.id);
        if (profile) cachedUser = { id: session.user.id, username: profile.username, email: profile.email };
      }
    } catch (e) {}
    readyResolve();
  }
  restoreSession();

  function isLoggedIn() { return !!cachedUser; }
  function currentUser() { return cachedUser; }

  async function usernameTaken(username, excludeId) {
    const { data, error } = await sb.rpc('is_username_taken', { check_username: username, exclude_id: excludeId || null });
    if (error) return false;
    return !!data;
  }
  async function emailTaken(email, excludeId) {
    const { data, error } = await sb.rpc('is_email_taken', { check_email: email, exclude_id: excludeId || null });
    if (error) return false;
    return !!data;
  }
  async function usernameForEmail(email) {
    const { data, error } = await sb.rpc('username_for_email', { p_email: email });
    if (error) return null;
    return data || null;
  }

  async function register(username, email, password) {
    username = (username || '').trim();
    email = (email || '').trim();
    const uErr = validateUsername(username);
    if (uErr) return { ok: false, message: uErr };
    const eErr = validateEmail(email);
    if (eErr) return { ok: false, message: eErr };
    const pErr = validatePassword(password);
    if (pErr) return { ok: false, message: pErr };

    if (await usernameTaken(username)) return { ok: false, message: 'Такой ник уже занят' };
    if (await emailTaken(email)) return { ok: false, message: 'Такой email уже используется' };

    const { data, error } = await sb.auth.signUp({ email: authEmailFor(username), password });
    if (error) {
      const msg = /registered/i.test(error.message) ? 'Этот ник уже занят, выбери другой' : 'Не удалось создать аккаунт: ' + error.message;
      return { ok: false, message: msg };
    }
    if (!data.user) return { ok: false, message: 'Не удалось создать аккаунт' };

    const { error: profileError } = await sb.from('profiles').insert({ id: data.user.id, username, email });
    if (profileError) {
      await sb.auth.signOut();
      const msg = profileError.code === '23505' ? 'Такой ник или email уже используется' : 'Не удалось сохранить профиль: ' + profileError.message;
      return { ok: false, message: msg };
    }

    cachedUser = { id: data.user.id, username, email };
    return { ok: true };
  }

  // identifier — ник или email, определяем автоматически по наличию "@"
  async function login(identifier, password) {
    identifier = (identifier || '').trim();
    if (!identifier || !password) return { ok: false, message: 'Заполни оба поля' };

    let username = identifier;
    if (identifier.includes('@')) {
      const resolved = await usernameForEmail(identifier);
      if (!resolved) return { ok: false, message: 'Неверный ник/email или пароль' };
      username = resolved;
    }

    const { data, error } = await sb.auth.signInWithPassword({ email: authEmailFor(username), password });
    if (error || !data.user) return { ok: false, message: 'Неверный ник/email или пароль' };
    const profile = await fetchProfile(data.user.id);
    cachedUser = { id: data.user.id, username: (profile && profile.username) || username, email: profile && profile.email };
    return { ok: true };
  }

  async function logout() {
    try { await sb.auth.signOut(); } catch (e) {}
    cachedUser = null;
  }

  async function requireLogin() {
    await ready;
    if (!isLoggedIn()) window.location.replace('login.html');
  }

  async function changeUsername(newUsername) {
    newUsername = (newUsername || '').trim();
    const uErr = validateUsername(newUsername);
    if (uErr) return { ok: false, message: uErr };
    if (!cachedUser) return { ok: false, message: 'Не авторизован' };
    if (newUsername.toLowerCase() === cachedUser.username.toLowerCase()) return { ok: true };
    if (await usernameTaken(newUsername, cachedUser.id)) return { ok: false, message: 'Такой ник уже занят' };

    // служебный email в Supabase Auth завязан на ник — меняем и его,
    // иначе следующий вход под новым ником не найдёт аккаунт
    const { error: authError } = await sb.auth.updateUser({ email: authEmailFor(newUsername) });
    if (authError) return { ok: false, message: 'Не удалось обновить ник: ' + authError.message };

    const { error } = await sb.from('profiles').update({ username: newUsername }).eq('id', cachedUser.id);
    if (error) return { ok: false, message: 'Не удалось обновить ник' };
    cachedUser.username = newUsername;
    return { ok: true };
  }

  async function changePassword(currentPassword, newPassword) {
    if (!cachedUser) return { ok: false, message: 'Не авторизован' };
    const pErr = validatePassword(newPassword);
    if (pErr) return { ok: false, message: pErr };
    const { error: reauthError } = await sb.auth.signInWithPassword({ email: authEmailFor(cachedUser.username), password: currentPassword });
    if (reauthError) return { ok: false, message: 'Неверный текущий пароль' };
    const { error } = await sb.auth.updateUser({ password: newPassword });
    if (error) return { ok: false, message: 'Не удалось изменить пароль' };
    return { ok: true };
  }

  async function deleteAccount() {
    // полное удаление пользователя из Supabase Auth требует service_role
    // ключа — его нельзя держать в браузере, поэтому кнопка выхода есть,
    // а самостоятельное удаление аккаунта отсюда недоступно.
    return { ok: false, message: 'Удаление аккаунта пока недоступно' };
  }

  return {
    ready, register, login, logout, isLoggedIn, currentUser, requireLogin,
    changeUsername, changePassword, deleteAccount,
  };
})();
