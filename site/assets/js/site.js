/* 任务看板官网 · 交互：主题、导航、截图画廊、复制、灯箱、入场 */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var $ = function (sel, scope) { return (scope || document).querySelector(sel); };
  var $$ = function (sel, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(sel)); };

  /* ---------- theme ---------- */
  var themeMeta = $('meta[name="theme-color"]');
  var themeToggle = $('#themeToggle');

  function applyTheme(theme, persist) {
    root.dataset.theme = theme;
    if (themeMeta) themeMeta.setAttribute('content', theme === 'dark' ? '#0f1011' : '#f4f4f1');
    if (themeToggle) {
      var toDark = theme !== 'dark';
      themeToggle.setAttribute('aria-label', toDark ? '切换到深色模式' : '切换到浅色模式');
      themeToggle.setAttribute('title', toDark ? '切换到深色模式' : '切换到浅色模式');
    }
    if (persist) {
      try { localStorage.setItem('kb-theme', theme); } catch (e) {}
    }
    renderGallery();
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', true);
    });
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
    var saved = null;
    try { saved = localStorage.getItem('kb-theme'); } catch (err) {}
    if (!saved) applyTheme(e.matches ? 'dark' : 'light', false);
  });

  /* ---------- header ---------- */
  var header = $('.site-header');
  var progress = $('#progress');

  function onScroll() {
    var y = window.scrollY || window.pageYOffset;
    if (header) header.classList.toggle('is-scrolled', y > 8);
    if (progress) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, y / max) : 0) + ')';
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- mobile nav ---------- */
  var menuBtn = $('#menuBtn');
  var nav = $('#nav');

  function setMenu(open) {
    if (!nav || !menuBtn) return;
    nav.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    menuBtn.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
    var icon = $('use', menuBtn);
    if (icon) icon.setAttribute('href', open ? '#i-close' : '#i-menu');
  }

  if (menuBtn) {
    menuBtn.addEventListener('click', function () {
      setMenu(!nav.classList.contains('open'));
    });
  }
  $$('#nav a').forEach(function (link) {
    link.addEventListener('click', function () { setMenu(false); });
  });
  document.addEventListener('click', function (e) {
    if (!nav || !menuBtn || !nav.classList.contains('open')) return;
    if (!nav.contains(e.target) && !menuBtn.contains(e.target)) setMenu(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') setMenu(false);
  });
  window.addEventListener('resize', function () {
    if (window.innerWidth > 820) setMenu(false);
  });

  /* ---------- scroll spy ---------- */
  var spyLinks = $$('#nav a[href^="#"]');
  var spyMap = {};
  spyLinks.forEach(function (link) { spyMap[link.getAttribute('href').slice(1)] = link; });
  if ('IntersectionObserver' in window) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        spyLinks.forEach(function (link) { link.removeAttribute('aria-current'); });
        var link = spyMap[entry.target.id];
        if (link) link.setAttribute('aria-current', 'true');
      });
    }, { rootMargin: '-42% 0px -52% 0px', threshold: 0 });
    Object.keys(spyMap).forEach(function (id) {
      var section = document.getElementById(id);
      if (section) spy.observe(section);
    });
  }

  /* ---------- gallery ---------- */
  var GALLERY = {
    board: {
      title: '四列看板',
      desc: '一列一个状态。卡片上直接执行、完成、撤销；已完成默认折成一行标题，一屏放得下更多历史。',
      alt: '任务看板：待办、进行中、待审核、已完成四列，每列一张浮起的圆角卡'
    },
    list: {
      title: '平铺列表',
      desc: '同一批卡片换成表格：状态是行内字段，点表头排序，默认按 待办 → 进行中 → 待审核 → 已完成 排。',
      alt: '列表视图：平铺表格，状态、编号、任务、用时、更新与操作六列'
    },
    settings: {
      title: '设置页',
      desc: '顶栏最右侧的齿轮。第一项「完成之后」决定点完成是立即完成，还是先发一条收尾提示词再自动完成。',
      alt: '设置页：完成之后的选择与只读的高级诊断信息'
    },
    compose: {
      title: '新建待办',
      desc: '正文、附件与所属工作区都在右侧抽屉里。自动保存成草稿后才出现卡片编号，右侧两个出口：保存或立即执行。',
      alt: '新建待办侧栏：标题、正文、附件、所属工作区与保存 / 立即执行'
    }
  };
  var galleryImg = $('#galleryImg');
  var galleryTitle = $('#galleryTitle');
  var galleryDesc = $('#galleryDesc');
  var galleryPanel = $('#galleryPanel');
  var tabs = $$('[role="tab"][data-tab]');
  var currentTab = 'board';
  var galleryHref = null;

  function gallerySrc(name, theme) {
    return 'assets/img/' + name + '-' + theme + '.webp';
  }

  function renderGallery() {
    if (!galleryImg || !GALLERY[currentTab]) return;
    var theme = root.dataset.theme === 'dark' ? 'dark' : 'light';
    var data = GALLERY[currentTab];
    var next = gallerySrc(currentTab, theme);
    galleryHref = next;
    galleryTitle.textContent = data.title;
    galleryDesc.textContent = data.desc;
    galleryImg.alt = data.alt;
    if (galleryImg.getAttribute('src') === next) return;
    var shot = galleryImg.closest('.shot');
    if (shot) shot.classList.add('is-loading');
    var loader = new Image();
    loader.onload = function () {
      galleryImg.src = next;
      if (shot) shot.classList.remove('is-loading');
    };
    loader.onerror = function () {
      if (shot) shot.classList.remove('is-loading');
    };
    loader.src = next;
  }

  function selectTab(name, focus) {
    var btn = tabs.filter(function (t) { return t.dataset.tab === name; })[0];
    if (!btn) return;
    currentTab = name;
    tabs.forEach(function (tab) {
      var on = tab === btn;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
    });
    if (galleryPanel) galleryPanel.setAttribute('aria-labelledby', btn.id);
    if (focus) btn.focus();
    renderGallery();
  }

  tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () { selectTab(tab.dataset.tab, false); });
    tab.addEventListener('keydown', function (e) {
      var next = null;
      if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next === null) return;
      e.preventDefault();
      selectTab(tabs[next].dataset.tab, true);
    });
  });

  // Warm the cache for the other tabs / theme variants after load.
  function warmGallery() {
    Object.keys(GALLERY).forEach(function (name) {
      ['light', 'dark'].forEach(function (theme) {
        var img = new Image();
        img.src = gallerySrc(name, theme);
      });
    });
  }
  if ('requestIdleCallback' in window) requestIdleCallback(warmGallery, { timeout: 4000 });
  else setTimeout(warmGallery, 1800);

  /* ---------- copy ---------- */
  $$('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy') || '';
      var label = $('span', btn);
      var original = label ? label.textContent : '';
      function done(ok) {
        if (!label) return;
        label.textContent = ok ? '已复制' : '复制失败';
        btn.classList.toggle('is-copied', ok);
        setTimeout(function () {
          label.textContent = original;
          btn.classList.remove('is-copied');
        }, 1600);
      }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      } else {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-999px';
        document.body.appendChild(area);
        area.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(area);
        done(ok);
      }
    });
  });

  /* ---------- lightbox ---------- */
  var lightbox = $('#lightbox');
  var lightboxImg = $('#lightboxImg');
  var lightboxTitle = $('#lightboxTitle');
  var shotBtn = $('.shot[data-lightbox]');

  if (lightbox && shotBtn && typeof lightbox.showModal === 'function') {
    shotBtn.addEventListener('click', function () {
      lightboxImg.src = galleryHref || galleryImg.src;
      lightboxImg.alt = galleryImg.alt;
      if (lightboxTitle) lightboxTitle.textContent = galleryTitle.textContent;
      lightbox.showModal();
    });
    lightbox.addEventListener('click', function (e) {
      if (e.target === lightbox) lightbox.close();
    });
  } else if (shotBtn) {
    shotBtn.addEventListener('click', function () {
      window.open(galleryHref || galleryImg.src, '_blank', 'noopener');
    });
  }

  /* ---------- reveal ---------- */
  var revealEls = $$('.reveal');
  if ('IntersectionObserver' in window && !reduceMotion.matches) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('in'); });
  }

  /* ---------- hero parallax ---------- */
  var stage = $('#heroStage');
  if (stage && window.matchMedia('(pointer: fine)').matches && !reduceMotion.matches) {
    var raf = 0;
    var tx = 0, ty = 0, cx = 0, cy = 0;
    var hero = $('.hero');
    hero.addEventListener('pointermove', function (e) {
      var rect = stage.getBoundingClientRect();
      tx = ((e.clientX - rect.left) / rect.width - 0.5) * -8;
      ty = ((e.clientY - rect.top) / rect.height - 0.5) * -6;
      if (!raf) raf = requestAnimationFrame(tick);
    });
    hero.addEventListener('pointerleave', function () {
      tx = 0; ty = 0;
      if (!raf) raf = requestAnimationFrame(tick);
    });
    function tick() {
      cx += (tx - cx) * 0.12;
      cy += (ty - cy) * 0.12;
      stage.style.transform = 'translate3d(' + cx.toFixed(2) + 'px,' + cy.toFixed(2) + 'px,0)';
      if (Math.abs(tx - cx) > 0.05 || Math.abs(ty - cy) > 0.05) raf = requestAnimationFrame(tick);
      else raf = 0;
    }
  }

  /* ---------- boot ---------- */
  applyTheme(root.dataset.theme === 'dark' ? 'dark' : 'light', false);
  renderGallery();
})();
