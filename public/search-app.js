      const EXAMPLES = [
        { intent: "EN", label: "quiet place to work in Gràcia" },
        { intent: "ES", label: "café de especialidad cerca de la Barceloneta" },
        { intent: "中文", label: "哥特区哪里能喝到手冲" },
        { intent: "RU", label: "тихое место с ноутбуком в Грасии" },
      ];

      const $ = (id) => document.getElementById(id);
      const state = {
        cards: [],
        openId: null,
        query: "",
        topN: 5,
        canShowMore: false,
        abort: null,
        leaflet: null,
      };

      function starsFor(rating) {
        const n = Math.round(Number(rating) || 0);
        return "★".repeat(Math.max(0, Math.min(5, n))) + "☆".repeat(Math.max(0, 5 - n));
      }

      function siteLabel(url) {
        try {
          return new URL(url).hostname.replace(/^www\./, "");
        } catch {
          return String(url || "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
        }
      }

      function cardFromResult(meta) {
        return {
          id: meta.place_id || meta.name,
          name: meta.name || "Unknown",
          rating: meta.rating || "",
          why: meta.why || "",
          address: meta.address || "",
          district: meta.district || "",
          mapUrl: meta.place_id
            ? `https://www.google.com/maps/place/?q=place_id:${meta.place_id}`
            : null,
          siteUrl: meta.website || null,
          latitude: meta.latitude ?? null,
          longitude: meta.longitude ?? null,
        };
      }

      function cardsFromResults(results, intro) {
        return {
          intro: intro || "",
          cafes: (results || []).map(cardFromResult),
        };
      }

      function parseLinkLine(line) {
        const map = line.match(/\[map\]\((https?:\/\/[^)\s]+)\)/i);
        const site = line.match(/\[site\]\((https?:\/\/[^)\s]+)\)/i);
        return { mapUrl: map?.[1] || null, siteUrl: site?.[1] || null };
      }

      function parseAnswer(answer, apiResults = []) {
        const byName = new Map(
          (apiResults || []).map((r) => [String(r.name || "").trim().toLowerCase(), r])
        );
        const blocks = String(answer || "")
          .trim()
          .split(/\n\s*\n/)
          .map((b) => b.trim())
          .filter(Boolean);

        let intro = "";
        const cafes = [];

        for (const block of blocks) {
          const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
          if (!lines.length) continue;
          const titleMatch = lines[0].match(/^(.*?)\s*★\s*([\d.]+)\s*$/);
          if (!titleMatch) {
            if (!intro) intro = lines.join(" ");
            continue;
          }

          const name = titleMatch[1].trim();
          const rating = titleMatch[2];
          const meta = byName.get(name.toLowerCase()) || {};
          let why = "";
          let address = meta.address || "";
          let mapUrl = meta.place_id
            ? `https://www.google.com/maps/place/?q=place_id:${meta.place_id}`
            : null;
          let siteUrl = meta.website || null;

          const linkLine = lines.find((l) => /\[map\]|\[site\]/i.test(l));
          if (linkLine) {
            const parsed = parseLinkLine(linkLine);
            mapUrl = parsed.mapUrl || mapUrl;
            siteUrl = parsed.siteUrl || siteUrl;
          }

          const contentLines = lines.slice(1).filter((l) => !/\[map\]|\[site\]/i.test(l));
          if (contentLines.length >= 1) why = contentLines[0];
          if (contentLines.length >= 2 && !address) {
            address = contentLines.slice(1).join(" ");
          }

          cafes.push({
            id: meta.place_id || name,
            name,
            rating: rating || meta.rating || "",
            why,
            address,
            district: meta.district || "",
            mapUrl,
            siteUrl,
            latitude: meta.latitude ?? null,
            longitude: meta.longitude ?? null,
          });
        }

        if (!cafes.length && apiResults.length) {
          for (const meta of apiResults) {
            cafes.push({
              id: meta.place_id || meta.name,
              name: meta.name || "Unknown",
              rating: meta.rating || "",
              why: "",
              address: meta.address || "",
              district: meta.district || "",
              mapUrl: meta.place_id
                ? `https://www.google.com/maps/place/?q=place_id:${meta.place_id}`
                : null,
              siteUrl: meta.website || null,
              latitude: meta.latitude ?? null,
              longitude: meta.longitude ?? null,
            });
          }
        }

        return { intro, cafes };
      }

      function parseSearchPayload(data) {
        const results = data.results || [];
        if (results.length) {
          const intro =
            data.intro ||
            String(data.answer || "")
              .trim()
              .split(/\n\s*\n/)[0] ||
            "";
          return cardsFromResults(results, intro);
        }
        return parseAnswer(data.answer || "", results);
      }

      function cafeHasGeo(c) {
        return Number.isFinite(Number(c.latitude)) && Number.isFinite(Number(c.longitude));
      }

      function projectPins(cards) {
        const pts = cards.filter(
          (c) => Number.isFinite(Number(c.latitude)) && Number.isFinite(Number(c.longitude))
        );
        if (!pts.length) {
          return cards.map((c, i) => ({
            ...c,
            x: `${18 + (i % 5) * 16}%`,
            y: `${32 + (i % 2) * 28}%`,
            geo: false,
          }));
        }
        const lats = pts.map((c) => Number(c.latitude));
        const lons = pts.map((c) => Number(c.longitude));
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const minLon = Math.min(...lons);
        const maxLon = Math.max(...lons);
        const latSpan = Math.max(maxLat - minLat, 0.002);
        const lonSpan = Math.max(maxLon - minLon, 0.002);
        return cards.map((c, i) => {
          if (!Number.isFinite(Number(c.latitude)) || !Number.isFinite(Number(c.longitude))) {
            return { ...c, x: `${18 + (i % 5) * 16}%`, y: `${32 + (i % 2) * 28}%`, geo: false };
          }
          const x = 14 + ((Number(c.longitude) - minLon) / lonSpan) * 72;
          const y = 18 + (1 - (Number(c.latitude) - minLat) / latSpan) * 62;
          return { ...c, x: `${x}%`, y: `${y}%`, geo: true };
        });
      }

      function renderExamples(target, items) {
        target.innerHTML = "";
        items.forEach((ex) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "pill";
          b.innerHTML = '<span class="intent"></span><span class="txt"></span>';
          b.querySelector(".intent").textContent = ex.intent || "";
          b.querySelector(".txt").textContent = ex.label;
          b.addEventListener("click", () => {
            $("query").value = ex.label;
            search(ex.label);
          });
          target.appendChild(b);
        });
      }

      function renderTokens(tokens) {
        const box = $("tokens");
        box.innerHTML = '<span class="label">Read as</span>';
        tokens.forEach((t) => {
          const el = document.createElement("span");
          el.className = "token";
          el.innerHTML = '<span class="kind"></span><span class="val"></span>';
          el.querySelector(".kind").textContent = t[0];
          el.querySelector(".val").textContent = t[1];
          box.appendChild(el);
        });
        box.hidden = tokens.length === 0;
        $("spacer").hidden = tokens.length > 0;
      }

      function tokensFrom(query, location) {
        const out = [];
        if (location?.location) out.push(["area", location.location]);
        const s = query.toLowerCase();
        if (/work|laptop|ноут|办公/.test(s)) out.push(["need", "laptop-friendly"]);
        if (/quiet|тих|安静/.test(s)) out.push(["need", "quiet"]);
        if (/specialty|filter|фильтр|especialidad|手冲/.test(s)) out.push(["need", "specialty"]);
        if (!out.length) out.push(["search", query.length > 36 ? `${query.slice(0, 36)}…` : query]);
        return out;
      }

      function answerParts(intro, cards) {
        const names = cards.map((c) => c.name).filter(Boolean);
        if (!intro) return names.length ? [{ place: names[0] }] : [];
        const parts = [];
        let rest = intro;
        const sorted = [...names].sort((a, b) => b.length - a.length);
        while (rest) {
          let hit = null;
          let at = -1;
          for (const name of sorted) {
            const i = rest.indexOf(name);
            if (i >= 0 && (at < 0 || i < at)) {
              hit = name;
              at = i;
            }
          }
          if (!hit) {
            parts.push(rest);
            break;
          }
          if (at > 0) parts.push(rest.slice(0, at));
          parts.push({ place: hit });
          rest = rest.slice(at + hit.length);
        }
        return parts;
      }

      function renderAnswer(parts) {
        const p = $("answer");
        p.innerHTML = "";
        parts.forEach((part) => {
          if (typeof part === "string") {
            p.appendChild(document.createTextNode(part));
          } else {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "place";
            b.textContent = part.place;
            b.addEventListener("click", () => toggle(part.place, true));
            p.appendChild(b);
          }
        });
        p.hidden = false;
      }

      function renderRows() {
        const box = $("results");
        box.innerHTML = "";
        const cards = state.cards;
        cards.forEach((c, i) => {
          const on = state.openId === c.id || state.openId === c.name;
          const row = document.createElement("div");
          row.className = "row" + (on ? " on" : "");
          row.innerHTML =
            '<button type="button" class="rowhead">' +
              '<span class="left">' +
                '<span class="num"></span>' +
                "<span>" +
                  '<span class="name"></span>' +
                  '<span class="meta1"><span class="stars"></span> <span class="rating"></span><span class="district"></span></span>' +
                "</span>" +
              "</span>" +
              '<span class="toggle"></span>' +
            "</button>";
          row.querySelector(".num").textContent = String(i + 1);
          row.querySelector(".name").textContent = c.name;
          row.querySelector(".stars").textContent = c.rating ? starsFor(c.rating) : "";
          row.querySelector(".rating").textContent = c.rating ? c.rating : "";
          row.querySelector(".district").textContent = c.district ? ` · ${c.district}` : "";
          row.querySelector(".toggle").textContent = on ? "Hide" : "Details";
          row.querySelector(".rowhead").addEventListener("click", () => toggle(c.id));

          if (on) {
            const d = document.createElement("div");
            d.className = "details";
            d.innerHTML = '<p></p><div class="addr"></div><div class="links"></div>';
            d.querySelector("p").textContent = c.why || "Listed because it matches the guide for this search.";
            d.querySelector(".addr").textContent = c.address || "";
            const links = d.querySelector(".links");
            if (c.mapUrl) {
              const maps = document.createElement("a");
              maps.target = "_blank";
              maps.rel = "noopener";
              maps.href = c.mapUrl;
              maps.textContent = `Open ${c.name} in Maps`;
              links.appendChild(maps);
              const dest = c.address || c.name;
              const dir = document.createElement("a");
              dir.target = "_blank";
              dir.rel = "noopener";
              dir.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
              dir.textContent = "Directions";
              links.appendChild(dir);
            }
            if (c.siteUrl) {
              const site = document.createElement("a");
              site.target = "_blank";
              site.rel = "noopener";
              site.href = c.siteUrl;
              site.textContent = siteLabel(c.siteUrl);
              links.appendChild(site);
            } else {
              const none = document.createElement("span");
              none.textContent = "No website in the guide";
              links.appendChild(none);
            }
            row.appendChild(d);
          }
          box.appendChild(row);
        });
        const hasGeo = cards.some(cafeHasGeo);
        $("map-wrap").hidden = !hasGeo;
        renderPins(cards);
        $("results-head").hidden = state.cards.length === 0;
        $("results-count").textContent =
          state.cards.length === 1
            ? "1 place from the guide"
            : `${state.cards.length} places from the guide`;
        $("map-caption").textContent = hasGeo
          ? "Pins follow cafe coordinates"
          : "Pins follow the list";
        $("more-btn").hidden = !state.canShowMore;
      }

      function renderPins(cards) {
        const geo = cards.filter(cafeHasGeo);
        const mapEl = $("map");
        const wrap = $("map-wrap");
        if (!geo.length) {
          if (state.leaflet) {
            state.leaflet.markers.clearLayers();
          }
          return;
        }
        if (window.L) {
          if (!state.leaflet) {
            const map = L.map(mapEl, {
              zoomControl: false,
              attributionControl: true,
            });
            L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
              attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
              subdomains: "abc",
              maxZoom: 19,
            }).addTo(map);
            state.leaflet = { map, markers: L.layerGroup().addTo(map) };
          }
          const { map, markers } = state.leaflet;
          markers.clearLayers();
          const bounds = [];
          geo.forEach((c, i) => {
            const lat = Number(c.latitude);
            const lng = Number(c.longitude);
            const on = state.openId === c.id || state.openId === c.name;
            const icon = L.divIcon({
              className: "pin" + (on ? " on" : ""),
              html: `<span class="dot">${i + 1}</span><span class="stick"></span>`,
              iconSize: [26, 36],
              iconAnchor: [13, 36],
            });
            const marker = L.marker([lat, lng], { icon, title: c.name });
            marker.on("click", () => toggle(c.id));
            marker.addTo(markers);
            bounds.push([lat, lng]);
          });
          wrap.hidden = false;
          map.invalidateSize();
          if (bounds.length === 1) {
            map.setView(bounds[0], 15);
          } else {
            map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
          }
          return;
        }
        const projected = projectPins(cards);
        mapEl.querySelectorAll(".pin").forEach((p) => p.remove());
        projected.forEach((c, i) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "pin" + (state.openId === c.id || state.openId === c.name ? " on" : "");
          b.style.position = "absolute";
          b.style.transform = "translate(-50%, -100%)";
          b.style.left = c.x;
          b.style.top = c.y;
          b.title = c.name;
          b.innerHTML = '<span class="dot"></span><span class="stick"></span>';
          b.querySelector(".dot").textContent = String(i + 1);
          b.addEventListener("click", () => toggle(c.id));
          mapEl.appendChild(b);
        });
      }

      function renderSkeletons(n) {
        const box = $("results");
        box.querySelectorAll(".skeleton").forEach((s) => s.remove());
        const widths = [["48%", "70%"], ["36%", "82%"], ["56%", "60%"]];
        for (let i = 0; i < n; i++) {
          const s = document.createElement("div");
          s.className = "skeleton";
          s.innerHTML = `<div class="a" style="width:${widths[i % 3][0]}"></div><div class="b" style="width:${widths[i % 3][1]}"></div>`;
          box.appendChild(s);
        }
      }

      function toggle(id, scroll) {
        const card = state.cards.find((c) => c.id === id || c.name === id);
        const key = card ? card.id : id;
        state.openId = state.openId === key ? null : key;
        renderRows();
        if (scroll && state.openId) {
          const i = state.cards.findIndex((c) => c.id === state.openId);
          const row = $("results").children[i];
          if (row) {
            window.scrollTo({
              top: row.getBoundingClientRect().top + window.scrollY - 90,
              behavior: "smooth",
            });
          }
        }
      }

      function resetView() {
        if (state.abort) state.abort.abort();
        state.cards = [];
        state.openId = null;
        state.canShowMore = false;
        $("results").innerHTML = "";
        ["answer", "notice", "map-wrap", "results-head", "more-btn", "error", "statusrow", "tokens"].forEach(
          (id) => ($(id).hidden = true)
        );
        $("spacer").hidden = false;
        $("hero").hidden = false;
        $("examples").hidden = false;
        $("search-btn").disabled = false;
      }

      async function search(q, topN = 5) {
        q = (q || "").trim();
        if (!q) return;
        state.query = q;
        state.topN = topN;
        if (state.abort) state.abort.abort();
        history.replaceState(null, "", `${location.pathname}${location.search}#q=${encodeURIComponent(q)}`);
        $("clear-btn").hidden = false;
        $("search-btn").disabled = true;

        state.cards = [];
        state.openId = null;
        $("results").innerHTML = "";
        ["answer", "notice", "map-wrap", "results-head", "more-btn", "error"].forEach((id) => ($(id).hidden = true));
        $("hero").hidden = true;
        $("examples").hidden = true;
        renderTokens(tokensFrom(q, null));
        $("statusrow").hidden = false;
        $("status").textContent = "Searching the guide…";
        renderSkeletons(3);

        const controller = new AbortController();
        state.abort = controller;

        try {
          const res = await fetch("/api/rag/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: q, topN }),
            signal: controller.signal,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

          const parsed = parseSearchPayload(data);
          state.cards = parsed.cafes;
          state.canShowMore = topN < 10 && parsed.cafes.length >= topN;
          renderTokens(tokensFrom(q, data.location));
          $("statusrow").hidden = true;
          renderSkeletons(0);
          $("search-btn").disabled = false;

          if (data.location?.notice) {
            $("notice").textContent = data.location.notice;
            $("notice").hidden = false;
          }

          if (!parsed.cafes.length) {
            $("answer").hidden = false;
            $("answer").textContent =
              parsed.intro || data.answer || "Nothing in the guide matches this.";
            return;
          }

          renderAnswer(answerParts(parsed.intro, parsed.cafes));
          renderRows();
          const resultsEl = $("results");
          if (resultsEl && parsed.cafes.length) {
            resultsEl.focus({ preventScroll: true });
          }
        } catch (err) {
          if (err.name === "AbortError") {
            $("status").textContent = "Stopped.";
            $("status").classList.remove("pulse");
            $("search-btn").disabled = false;
            renderSkeletons(0);
            return;
          }
          $("statusrow").hidden = true;
          renderSkeletons(0);
          $("error").hidden = false;
          $("search-btn").disabled = false;
        }
      }

      renderExamples($("examples"), EXAMPLES);

      $("search-form").addEventListener("submit", (e) => {
        e.preventDefault();
        $("query").blur();
        search($("query").value, 5);
      });
      $("query").addEventListener("input", (e) => {
        $("clear-btn").hidden = !e.target.value;
      });
      $("query").addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          $("query").value = "";
          $("clear-btn").hidden = true;
          resetView();
          history.replaceState(null, "", location.pathname + location.search);
        }
      });
      $("clear-btn").addEventListener("click", () => {
        $("query").value = "";
        $("clear-btn").hidden = true;
        resetView();
        $("query").focus();
        history.replaceState(null, "", location.pathname + location.search);
      });
      $("stop-btn").addEventListener("click", () => {
        if (state.abort) state.abort.abort();
      });
      $("retry-btn").addEventListener("click", () => search(state.query, state.topN));
      $("more-btn").addEventListener("click", () => search(state.query, 10));
      $("copy-btn").addEventListener("click", () => {
        if (navigator.clipboard) navigator.clipboard.writeText(location.href);
        $("copy-btn").textContent = "Link copied";
        setTimeout(() => ($("copy-btn").textContent = "Copy link"), 1800);
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "/" && document.activeElement !== $("query")) {
          e.preventDefault();
          $("query").focus();
        }
      });

      if (window.innerWidth > 820) {
        $("query").focus();
        $("keyhint").hidden = false;
      }
      const fromUrl = /[?&#]q=([^&]+)/.exec(location.href);
      if (fromUrl) {
        const q = decodeURIComponent(fromUrl[1].replace(/\+/g, " "));
        $("query").value = q;
        search(q);
      }
