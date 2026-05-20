(function () {
  const root = window;
  const state = root.__fundaceTracking || {
    loading: false,
    ready: false,
    metaPixels: {},
    ga4Ids: {},
  };

  root.__fundaceTracking = state;

  function clean(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function configEndpoint() {
    const config = root.SUPABASE_CONFIG || {};
    if (clean(config.trackingConfigUrl)) return clean(config.trackingConfigUrl);
    if (!clean(config.url)) return "";
    return `${clean(config.url).replace(/\/+$/, "")}/functions/v1/qualified-lead-tracking`;
  }

  function authHeaders() {
    const anonKey = clean(root.SUPABASE_CONFIG && root.SUPABASE_CONFIG.anonKey);
    if (!anonKey) return {};
    return {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    };
  }

  function ensureFbq() {
    if (root.fbq) return;

    (function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n;
      n.loaded = true;
      n.version = "2.0";
      n.queue = [];
      t = b.createElement(e);
      t.async = true;
      t.src = v;
      s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    })(root, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
  }

  function initMetaPixel(pixelId) {
    const id = clean(pixelId);
    if (!/^\d+$/.test(id) || state.metaPixels[id]) return;

    ensureFbq();
    root.fbq("init", id);
    root.fbq("track", "PageView");
    state.metaPixels[id] = true;
  }

  function initGa4(measurementId) {
    const id = clean(measurementId);
    if (!/^G-[A-Z0-9]+$/i.test(id) || state.ga4Ids[id]) return;

    root.dataLayer = root.dataLayer || [];
    root.gtag = root.gtag || function () {
      root.dataLayer.push(arguments);
    };

    if (!document.querySelector(`script[src*="googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}"]`)) {
      const script = document.createElement("script");
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
      document.head.appendChild(script);
    }

    root.gtag("js", new Date());
    root.gtag("config", id);
    state.ga4Ids[id] = true;
  }

  function initTracking(config) {
    const local = root.FUNDACE_TRACKING || {};
    initMetaPixel(clean(config.metaPixelId) || clean(local.metaPixelId));
    initGa4(clean(config.ga4MeasurementId) || clean(local.ga4MeasurementId));
  }

  if (state.loading || state.ready) return;
  state.loading = true;

  const endpoint = configEndpoint();
  if (!endpoint) {
    initTracking({});
    state.loading = false;
    state.ready = true;
    return;
  }

  fetch(endpoint, {
    method: "GET",
    headers: authHeaders(),
    cache: "no-store",
  })
    .then(response => response.ok ? response.json() : {})
    .then(config => initTracking(config || {}))
    .catch(() => initTracking({}))
    .finally(() => {
      state.loading = false;
      state.ready = true;
    });
})();
