const CACHE_NAME = "tutorux-web-v11";
const APP_FILES = [
    "./",
    "./index.html",
    "./tutorux.css",
    "./tutorux.js",
    "./journal-ui.js",
    "./tutorux-theme.js",
    "./tutorux-layout.js",
    "./tutorux-worker.js",
    "./tutorux-recorder-worklet.js",
    "./manifest.webmanifest",
    "./assets/tutorux.svg",
    "./assets/favicon.ico",
    "./assets/tutorux-32.png",
    "./assets/tutorux-180.png",
    "./assets/tutorux-192.png",
    "./assets/tutorux-512.png",
    "./tutorux-core.js",
    "./tutorux-core.wasm",
];
const OPTIONAL_APP_FILES = ["./docs/tutorial/quick-guide.mp4", "./docs/tutorial/README.md"];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            await cache.addAll(APP_FILES);
            await Promise.allSettled(OPTIONAL_APP_FILES.map((path) => cache.add(path)));
        }),
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
        ),
    );
});

self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") {
        return;
    }
    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) {
                return cached;
            }
            return fetch(event.request);
        }),
    );
});
