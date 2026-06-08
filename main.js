(() => {
  "use strict";

  /*
   * 2D isometric room renderer for the ROOM tab.
   * The existing app remains React-based; this file only boots inside elements
   * marked with data-myroom-app.
   */

  // ---------------------------------------------------------------------------
  // Room, tile, wall, and camera settings.
  // ---------------------------------------------------------------------------
  const ROOM_CONFIG = {
    roomWidth: 3,
    roomHeight: 3,
    tileWidth: 600,
    tileHeight: 452,
    wallHeight: 330,
    floorEdgeDepth: 34,
    cameraStartX: 0,
    cameraStartY: 22,
    cameraStartZoom: 0.58,
    minZoom: 0.36,
    maxZoom: 1.2,
    assets: {
      wallpaper: ["./assets/1.png", "./PNG/1.png"],
      floorTile: ["./assets/2.png", "./PNG/2.png"],
    },
  };

  const FURNITURE_CATALOG = [
    {
      id: "drawer",
      label: "Drawer",
      sources: ["./assets/3.png", "./PNG/3.png"],
      width: 0.5,
      depth: 0.5,
      drawWidth: 204,
      drawHeight: 288,
      anchorOffsetY: 15,
      crop: { x: 0.14, y: 0, width: 0.72, height: 1 },
    },
  ];

  const placedObjects = [];
  let nextObjectId = 1;

  const FLOOR_TILE_IMAGE_ALPHA_BOUNDS = {
    x: 9,
    y: 76,
    width: 682,
    height: 543,
  };
  const FLOOR_TILE_JOIN_OVERLAP = 5;
  const FLOOR_TILE_UNDERLAY_FILL = "#6a371d";
  const FLOOR_TOP_TEXTURE_BLEED = 42;
  const FLOOR_TOP_CLIP_OVERLAP = 1.5;
  const FLOOR_EDGE_LEFT_FILL = "#4b2416";
  const FLOOR_EDGE_RIGHT_FILL = "#5b2d18";
  const FLOOR_EDGE_STROKE = "rgba(42, 19, 10, .94)";
  const FLOOR_EDGE_HIGHLIGHT = "rgba(150, 78, 39, .58)";
  const WALL_PANEL_OVERLAP = 3;
  const WALL_FLOOR_OVERLAP = 10;
  const FURNITURE_GRID_STEP = 0.5;

  const instances = new WeakMap();

  // ---------------------------------------------------------------------------
  // Isometric coordinate conversion.
  // ---------------------------------------------------------------------------
  function isoToScreen(gridX, gridY) {
    const tileWidth = ROOM_CONFIG.tileWidth;
    const tileHeight = ROOM_CONFIG.tileHeight;
    return {
      x: (gridX - gridY) * tileWidth / 2,
      y: (gridX + gridY) * tileHeight / 2,
    };
  }

  function screenToIso(worldX, worldY) {
    const tileWidth = ROOM_CONFIG.tileWidth;
    const tileHeight = ROOM_CONFIG.tileHeight;
    return {
      gridX: worldY / tileHeight + worldX / tileWidth,
      gridY: worldY / tileHeight - worldX / tileWidth,
    };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function snapDown(value, step) {
    return Number((Math.floor(value / step + 1e-6) * step).toFixed(3));
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Failed to load image: ${src}`));
      image.src = src;
    });
  }

  async function loadFirstImage(sources) {
    const errors = [];
    for (const source of sources) {
      try {
        return await loadImage(source);
      } catch (error) {
        errors.push(error.message);
      }
    }
    throw new Error(errors.join(" / "));
  }

  async function loadFurnitureImages() {
    const entries = await Promise.all(
      FURNITURE_CATALOG.map(async (item) => {
        try {
          return [item.id, await loadFirstImage(item.sources)];
        } catch {
          return [item.id, null];
        }
      }),
    );
    return Object.fromEntries(entries.filter(([, image]) => image));
  }

  function getRoomMetrics() {
    const p00 = isoToScreen(0, 0);
    const pW0 = isoToScreen(ROOM_CONFIG.roomWidth, 0);
    const p0H = isoToScreen(0, ROOM_CONFIG.roomHeight);
    const pWH = isoToScreen(ROOM_CONFIG.roomWidth, ROOM_CONFIG.roomHeight);
    const minX = Math.min(p00.x, pW0.x, p0H.x, pWH.x);
    const maxX = Math.max(p00.x, pW0.x, p0H.x, pWH.x);
    const minY = Math.min(p00.y - ROOM_CONFIG.wallHeight, pW0.y - ROOM_CONFIG.wallHeight, p0H.y, pWH.y);
    const maxY = pWH.y + ROOM_CONFIG.floorEdgeDepth;

    return {
      p00,
      pW0,
      p0H,
      pWH,
      centerOffset: {
        x: -(minX + maxX) / 2,
        y: -(minY + maxY) / 2 + 18,
      },
    };
  }

  function tilePolygon(gridX, gridY, spanX = 1, spanY = 1) {
    return [
      isoToScreen(gridX, gridY),
      isoToScreen(gridX + spanX, gridY),
      isoToScreen(gridX + spanX, gridY + spanY),
      isoToScreen(gridX, gridY + spanY),
    ];
  }

  function tracePolygon(ctx, points) {
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
  }

  function drawPolygon(ctx, points, fill, stroke, lineWidth = 1) {
    ctx.save();
    tracePolygon(ctx, points);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
    ctx.restore();
  }

  function expandPolygon(points, amount) {
    const center = points.reduce(
      (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
      { x: 0, y: 0 },
    );

    return points.map((point) => {
      const dx = point.x - center.x;
      const dy = point.y - center.y;
      const distance = Math.hypot(dx, dy) || 1;
      return {
        x: point.x + dx / distance * amount,
        y: point.y + dy / distance * amount,
      };
    });
  }

  function overlapWallFloor(points) {
    return points.map((point, index) => (
      index >= 2 ? { x: point.x, y: point.y + WALL_FLOOR_OVERLAP } : point
    ));
  }

  // ---------------------------------------------------------------------------
  // Wall drawing. Each logical wall cell receives one fitted 1.png image.
  // ---------------------------------------------------------------------------
  function drawImageInQuad(ctx, image, points, shade) {
    const topLeft = points[0];
    const topRight = points[1];
    const bottomLeft = points[3];

    ctx.save();
    tracePolygon(ctx, points);
    ctx.clip();
    ctx.transform(
      topRight.x - topLeft.x,
      topRight.y - topLeft.y,
      bottomLeft.x - topLeft.x,
      bottomLeft.y - topLeft.y,
      topLeft.x,
      topLeft.y,
    );
    ctx.drawImage(image, 0, 0, 1, 1);
    if (shade) {
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, 1, 1);
    }
    ctx.restore();
  }

  function drawWallPanel(ctx, points, wallpaper, shade) {
    drawImageInQuad(ctx, wallpaper, expandPolygon(points, WALL_PANEL_OVERLAP), shade);
  }

  function renderWallBackfills(ctx, metrics) {
    const top = metrics.p00;
    const right = metrics.pW0;
    const left = metrics.p0H;

    drawPolygon(
      ctx,
      overlapWallFloor([
        { x: top.x, y: top.y - ROOM_CONFIG.wallHeight },
        { x: left.x, y: left.y - ROOM_CONFIG.wallHeight },
        left,
        top,
      ]),
      "#ead5ad",
      null,
    );

    drawPolygon(
      ctx,
      overlapWallFloor([
        { x: top.x, y: top.y - ROOM_CONFIG.wallHeight },
        { x: right.x, y: right.y - ROOM_CONFIG.wallHeight },
        right,
        top,
      ]),
      "#f0dcba",
      null,
    );
  }

  function renderWallCells(ctx, wallpaper) {
    for (let gridY = 0; gridY < ROOM_CONFIG.roomHeight; gridY += 1) {
      const floorA = isoToScreen(0, gridY);
      const floorB = isoToScreen(0, gridY + 1);
      drawWallPanel(
        ctx,
        overlapWallFloor([
          { x: floorA.x, y: floorA.y - ROOM_CONFIG.wallHeight },
          { x: floorB.x, y: floorB.y - ROOM_CONFIG.wallHeight },
          floorB,
          floorA,
        ]),
        wallpaper,
        "rgba(236, 214, 174, .08)",
      );
    }

    for (let gridX = 0; gridX < ROOM_CONFIG.roomWidth; gridX += 1) {
      const floorA = isoToScreen(gridX, 0);
      const floorB = isoToScreen(gridX + 1, 0);
      drawWallPanel(
        ctx,
        overlapWallFloor([
          { x: floorA.x, y: floorA.y - ROOM_CONFIG.wallHeight },
          { x: floorB.x, y: floorB.y - ROOM_CONFIG.wallHeight },
          floorB,
          floorA,
        ]),
        wallpaper,
        "rgba(255, 255, 255, .08)",
      );
    }
  }

  function renderWalls(ctx, metrics, images) {
    renderWallBackfills(ctx, metrics);
    renderWallCells(ctx, images.wallpaper);
  }

  function renderWallFloorJoin(ctx, metrics) {
    const top = metrics.p00;
    const right = metrics.pW0;
    const left = metrics.p0H;

    // Base trim and contact shadow where the wall meets the floor.
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 18;
    ctx.strokeStyle = "rgba(28, 16, 10, .24)";
    ctx.beginPath();
    ctx.moveTo(left.x, left.y);
    ctx.lineTo(top.x, top.y);
    ctx.lineTo(right.x, right.y);
    ctx.stroke();

    ctx.lineWidth = 7;
    ctx.strokeStyle = "rgba(113, 80, 54, .82)";
    ctx.stroke();
    ctx.restore();
  }

  function renderWallCornerPost(ctx, metrics) {
    const top = metrics.p00;
    const wallTop = { x: top.x, y: top.y - ROOM_CONFIG.wallHeight };

    // Corner post.
    ctx.save();
    ctx.lineWidth = 10;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(78, 57, 41, .9)";
    ctx.beginPath();
    ctx.moveTo(wallTop.x, wallTop.y + 2);
    ctx.lineTo(top.x, top.y + 6);
    ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Floor drawing. Each selected 3x3 tile receives one fitted 2.png image.
  // ---------------------------------------------------------------------------
  function renderFloorTileUnderlay(ctx, gridX, gridY) {
    drawPolygon(
      ctx,
      expandPolygon(tilePolygon(gridX, gridY), FLOOR_TILE_JOIN_OVERLAP),
      FLOOR_TILE_UNDERLAY_FILL,
      null,
    );
  }

  function getFloorTileImageRect(gridX, gridY, floorImage, bleed) {
    const points = tilePolygon(gridX, gridY);
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const targetWidth = maxX - minX + bleed * 2;
    const scale = targetWidth / FLOOR_TILE_IMAGE_ALPHA_BOUNDS.width;

    return {
      x: minX - bleed - FLOOR_TILE_IMAGE_ALPHA_BOUNDS.x * scale,
      y: minY - bleed - FLOOR_TILE_IMAGE_ALPHA_BOUNDS.y * scale,
      width: (floorImage.naturalWidth || floorImage.width) * scale,
      height: (floorImage.naturalHeight || floorImage.height) * scale,
    };
  }

  function renderFloorTileTopOverlay(ctx, gridX, gridY, floorImage) {
    const rect = getFloorTileImageRect(gridX, gridY, floorImage, FLOOR_TOP_TEXTURE_BLEED);

    ctx.save();
    tracePolygon(ctx, expandPolygon(tilePolygon(gridX, gridY), FLOOR_TOP_CLIP_OVERLAP));
    ctx.clip();
    ctx.drawImage(floorImage, rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
  }

  function renderFloorTiles(ctx, floorImage, metrics) {
    const tiles = [];
    for (let gridY = 0; gridY < ROOM_CONFIG.roomHeight; gridY += 1) {
      for (let gridX = 0; gridX < ROOM_CONFIG.roomWidth; gridX += 1) {
        tiles.push({ gridX, gridY });
      }
    }

    withFloorClip(ctx, metrics, () => {
      tiles
        .sort((a, b) => (a.gridX + a.gridY) - (b.gridX + b.gridY))
        .forEach((tile) => renderFloorTileUnderlay(ctx, tile.gridX, tile.gridY));

      tiles.forEach((tile) => renderFloorTileTopOverlay(ctx, tile.gridX, tile.gridY, floorImage));
    });
  }

  function renderFloorOuterEdge(ctx, metrics) {
    const { p0H, pW0, pWH } = metrics;
    const edgeDepth = ROOM_CONFIG.floorEdgeDepth;
    const leftBottom = { x: p0H.x, y: p0H.y + edgeDepth };
    const frontBottom = { x: pWH.x, y: pWH.y + edgeDepth };
    const rightBottom = { x: pW0.x, y: pW0.y + edgeDepth };

    drawPolygon(ctx, [p0H, pWH, frontBottom, leftBottom], FLOOR_EDGE_LEFT_FILL, FLOOR_EDGE_STROKE, 1);
    drawPolygon(ctx, [pWH, pW0, rightBottom, frontBottom], FLOOR_EDGE_RIGHT_FILL, FLOOR_EDGE_STROKE, 1);

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.lineWidth = 8;
    ctx.strokeStyle = FLOOR_EDGE_STROKE;
    ctx.beginPath();
    ctx.moveTo(p0H.x, p0H.y);
    ctx.lineTo(pWH.x, pWH.y);
    ctx.lineTo(pW0.x, pW0.y);
    ctx.stroke();

    ctx.lineWidth = 2;
    ctx.strokeStyle = FLOOR_EDGE_HIGHLIGHT;
    ctx.beginPath();
    ctx.moveTo(p0H.x + 5, p0H.y + 4);
    ctx.lineTo(pWH.x, pWH.y + 4);
    ctx.lineTo(pW0.x - 5, pW0.y + 4);
    ctx.stroke();

    [p0H, pWH, pW0].forEach((point) => {
      ctx.beginPath();
      ctx.moveTo(point.x, point.y + 2);
      ctx.lineTo(point.x, point.y + edgeDepth - 2);
      ctx.strokeStyle = "rgba(31, 13, 7, .82)";
      ctx.lineWidth = 3;
      ctx.stroke();
    });

    ctx.restore();
  }

  function renderFloor(ctx, metrics, images) {
    const floor = [metrics.p00, metrics.pW0, metrics.pWH, metrics.p0H];
    const edgeDepth = ROOM_CONFIG.floorEdgeDepth;

    // Room-wide shadow.
    drawPolygon(
      ctx,
      floor.map((point) => ({ x: point.x, y: point.y + edgeDepth })),
      "rgba(0, 0, 0, .26)",
      null,
    );

    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, .45)";
    ctx.shadowBlur = 34;
    ctx.shadowOffsetY = 24;
    drawPolygon(ctx, floor, "rgba(36, 18, 10, .22)", null);
    ctx.restore();

    renderFloorTiles(ctx, images.floorTile, metrics);
    renderFloorOuterEdge(ctx, metrics);
  }

  function withFloorClip(ctx, metrics, draw) {
    const floor = [metrics.p00, metrics.pW0, metrics.pWH, metrics.p0H];
    ctx.save();
    tracePolygon(ctx, floor);
    ctx.clip();
    draw();
    ctx.restore();
  }

  function renderGrid(ctx, metrics) {
    withFloorClip(ctx, metrics, () => {
      for (let gridY = 0; gridY < ROOM_CONFIG.roomHeight; gridY += 1) {
        for (let gridX = 0; gridX < ROOM_CONFIG.roomWidth; gridX += 1) {
          drawPolygon(
            ctx,
            tilePolygon(gridX, gridY),
            "rgba(98, 210, 255, .08)",
            null,
          );
        }
      }

      ctx.save();
      ctx.lineCap = "butt";
      ctx.lineJoin = "miter";
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(115, 218, 255, .62)";

      for (let gridX = 1; gridX < ROOM_CONFIG.roomWidth; gridX += 1) {
        const start = isoToScreen(gridX, 0);
        const end = isoToScreen(gridX, ROOM_CONFIG.roomHeight);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
      }

      for (let gridY = 1; gridY < ROOM_CONFIG.roomHeight; gridY += 1) {
        const start = isoToScreen(0, gridY);
        const end = isoToScreen(ROOM_CONFIG.roomWidth, gridY);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
      }

      ctx.restore();
    });
  }

  function renderSelection(ctx, selectedTile, metrics) {
    if (!selectedTile) return;

    withFloorClip(ctx, metrics, () => {
      drawPolygon(
        ctx,
        tilePolygon(
          selectedTile.gridX,
          selectedTile.gridY,
          selectedTile.width ?? 1,
          selectedTile.depth ?? 1,
        ),
        "rgba(255, 236, 129, .38)",
        "rgba(255, 250, 202, .95)",
        4,
      );
    });
  }

  function renderPlacementPreview(ctx, previewTile, metrics) {
    if (!previewTile) return;

    withFloorClip(ctx, metrics, () => {
      drawPolygon(
        ctx,
        tilePolygon(
          previewTile.gridX,
          previewTile.gridY,
          previewTile.width ?? 1,
          previewTile.depth ?? 1,
        ),
        "rgba(87, 151, 99, .2)",
        "rgba(255, 252, 221, .95)",
        5,
      );
    });
  }

  function drawFurnitureImage(ctx, object, x, y, width, height) {
    const image = object.imageElement;
    const crop = object.crop;
    if (!image) return;

    function drawAt(drawX, drawY) {
      if (!crop) {
        ctx.drawImage(image, drawX, drawY, width, height);
        return;
      }

      const sourceWidth = image.naturalWidth || image.width;
      const sourceHeight = image.naturalHeight || image.height;
      ctx.drawImage(
        image,
        crop.x * sourceWidth,
        crop.y * sourceHeight,
        crop.width * sourceWidth,
        crop.height * sourceHeight,
        drawX,
        drawY,
        width,
        height,
      );
    }

    ctx.save();
    if (object.flipped) {
      ctx.translate(x + width / 2, y + height / 2);
      ctx.scale(-1, 1);
      drawAt(-width / 2, -height / 2);
    } else {
      drawAt(x, y);
    }
    ctx.restore();
  }

  function getObjectDrawRect(object) {
    const anchor = isoToScreen(
      object.gridX + (object.width ?? 1) / 2,
      object.gridY + (object.depth ?? 1) / 2,
    );
    const width = object.drawWidth ?? 160;
    const height = object.drawHeight ?? 190;
    return {
      x: anchor.x - width / 2,
      y: anchor.y - height + (object.anchorOffsetY ?? 0),
      width,
      height,
    };
  }

  function findObjectAtRoomPoint(roomX, roomY) {
    const sortedObjects = [...placedObjects]
      .sort((a, b) => (
        a.gridX + a.gridY + (a.depth ?? 1)
      ) - (
        b.gridX + b.gridY + (b.depth ?? 1)
      ))
      .reverse();

    return sortedObjects.find((object) => {
      const rect = getObjectDrawRect(object);
      return (
        roomX >= rect.x &&
        roomX <= rect.x + rect.width &&
        roomY >= rect.y &&
        roomY <= rect.y + rect.height
      );
    }) ?? null;
  }

  function renderObjectSelectionOverlay(ctx, rect, time) {
    const pulse = 0.5 + Math.sin(time / 260) * 0.5;
    const bandProgress = (time % 1300) / 1300;
    const bandX = rect.x - rect.width + bandProgress * rect.width * 2.6;

    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();

    ctx.fillStyle = `rgba(255, 218, 86, ${0.12 + pulse * 0.05})`;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

    const shine = ctx.createLinearGradient(
      bandX - 42,
      rect.y,
      bandX + 74,
      rect.y + rect.height,
    );
    shine.addColorStop(0, "rgba(255, 255, 255, 0)");
    shine.addColorStop(0.45, "rgba(255, 255, 230, 0.44)");
    shine.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = shine;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.restore();

    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = `rgba(255, 244, 177, ${0.78 + pulse * 0.18})`;
    ctx.shadowColor = "rgba(255, 214, 89, .62)";
    ctx.shadowBlur = 14 + pulse * 8;
    ctx.strokeRect(rect.x + 2, rect.y + 2, rect.width - 4, rect.height - 4);
    ctx.restore();
  }

  function renderObjects(ctx, objects, selectedObjectId) {
    const time = performance.now();
    const sortedObjects = [...objects].sort((a, b) => (
      a.gridX + a.gridY + (a.depth ?? 1)
    ) - (
      b.gridX + b.gridY + (b.depth ?? 1)
    ));

    sortedObjects.forEach((object) => {
      if (object.imageElement) {
        const rect = getObjectDrawRect(object);
        ctx.save();
        ctx.shadowColor = "rgba(35, 20, 12, .28)";
        ctx.shadowBlur = 18;
        ctx.shadowOffsetY = 10;
        drawFurnitureImage(
          ctx,
          object,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
        );
        ctx.restore();
        if (object.uid === selectedObjectId) {
          renderObjectSelectionOverlay(ctx, rect, time);
        }
        return;
      }

      // Lightweight placeholder for future object anchors.
      const anchor = isoToScreen(object.gridX, object.gridY);
      ctx.save();
      ctx.globalAlpha = object.opacity ?? .75;
      ctx.fillStyle = object.color ?? "#f8dfb6";
      ctx.beginPath();
      ctx.ellipse(anchor.x, anchor.y - 24, 18, 28, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  function clearCanvas(ctx, width, height) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.restore();
  }

  function renderRoom(ctx, state, size, images) {
    const metrics = getRoomMetrics();
    clearCanvas(ctx, size.pixelWidth, size.pixelHeight);

    ctx.save();
    ctx.scale(size.dpr, size.dpr);
    ctx.translate(size.cssWidth / 2 + state.camera.x, size.cssHeight / 2 + state.camera.y);
    ctx.scale(state.camera.zoom, state.camera.zoom);
    ctx.translate(metrics.centerOffset.x, metrics.centerOffset.y);

    renderWalls(ctx, metrics, images);
    renderFloor(ctx, metrics, images);
    if (state.showGrid) renderGrid(ctx, metrics);
    renderSelection(ctx, state.selectedTile, metrics);
    renderPlacementPreview(ctx, state.dragPreviewTile, metrics);
    renderWallFloorJoin(ctx, metrics);
    renderWallCornerPost(ctx, metrics);
    renderObjects(ctx, placedObjects, state.selectedObjectId);

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Camera, selection, and interaction.
  // ---------------------------------------------------------------------------
  function createState() {
    return {
      camera: {
        x: ROOM_CONFIG.cameraStartX,
        y: ROOM_CONFIG.cameraStartY,
        zoom: ROOM_CONFIG.cameraStartZoom,
      },
      selectedTile: null,
      selectedObjectId: null,
      dragPreviewTile: null,
      showGrid: false,
      pointer: {
        isDown: false,
        moved: false,
        lastX: 0,
        lastY: 0,
      },
    };
  }

  function screenPointToGrid(canvas, state, clientX, clientY) {
    const roomPoint = screenPointToRoom(canvas, state, clientX, clientY);
    const iso = screenToIso(roomPoint.x, roomPoint.y);

    return {
      gridX: Math.floor(iso.gridX),
      gridY: Math.floor(iso.gridY),
    };
  }

  function screenPointToFurnitureGrid(canvas, state, clientX, clientY) {
    const roomPoint = screenPointToRoom(canvas, state, clientX, clientY);
    const iso = screenToIso(roomPoint.x, roomPoint.y);

    return {
      gridX: snapDown(iso.gridX, FURNITURE_GRID_STEP),
      gridY: snapDown(iso.gridY, FURNITURE_GRID_STEP),
    };
  }

  function screenPointToRoom(canvas, state, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const metrics = getRoomMetrics();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;

    return {
      x: (localX - rect.width / 2 - state.camera.x) / state.camera.zoom - metrics.centerOffset.x,
      y: (localY - rect.height / 2 - state.camera.y) / state.camera.zoom - metrics.centerOffset.y,
    };
  }

  function isInsideRoom(tile) {
    return (
      Boolean(tile) &&
      tile.gridX >= 0 &&
      tile.gridY >= 0 &&
      tile.gridX < ROOM_CONFIG.roomWidth &&
      tile.gridY < ROOM_CONFIG.roomHeight
    );
  }

  function isFurnitureInsideRoom(tile, item) {
    const width = item?.width ?? 1;
    const depth = item?.depth ?? 1;
    return (
      Boolean(tile) &&
      tile.gridX >= 0 &&
      tile.gridY >= 0 &&
      tile.gridX + width <= ROOM_CONFIG.roomWidth &&
      tile.gridY + depth <= ROOM_CONFIG.roomHeight
    );
  }

  function createFurniturePalette(app) {
    const palette = document.createElement("aside");
    palette.className = "myroom-furniture-palette";
    palette.setAttribute("aria-label", "furniture");

    FURNITURE_CATALOG.forEach((item) => {
      const button = document.createElement("button");
      button.className = "myroom-furniture-item";
      button.type = "button";
      button.dataset.furnitureId = item.id;
      button.setAttribute("aria-label", item.label);

      const image = document.createElement("img");
      image.src = item.sources[0];
      image.alt = "";
      image.draggable = false;
      button.appendChild(image);
      palette.appendChild(button);
    });

    const controls = document.createElement("div");
    controls.className = "myroom-furniture-controls";

    const flipButton = document.createElement("button");
    flipButton.className = "myroom-furniture-flip";
    flipButton.type = "button";
    flipButton.dataset.myroomFlip = "true";
    flipButton.disabled = true;
    flipButton.setAttribute("aria-label", "flip selected furniture");
    flipButton.textContent = "Flip";
    controls.appendChild(flipButton);

    const deleteButton = document.createElement("button");
    deleteButton.className = "myroom-furniture-delete";
    deleteButton.type = "button";
    deleteButton.dataset.myroomDelete = "true";
    deleteButton.disabled = true;
    deleteButton.setAttribute("aria-label", "delete selected furniture");
    deleteButton.textContent = "Delete";
    controls.appendChild(deleteButton);

    palette.appendChild(controls);

    app.appendChild(palette);
    return palette;
  }

  function createRoom(app) {
    const gameRoot = app.querySelector("[data-myroom-game]");
    const gridButton = app.querySelector("[data-myroom-grid-toggle]");
    const backButton = app.querySelector(".myroom-icon-button[aria-label='back']");
    const status = app.querySelector("[data-myroom-status]");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: true });

    if (!gameRoot || !ctx) {
      app.insertAdjacentHTML("beforeend", '<div class="myroom-load-error">Room canvas could not start.</div>');
      return { destroy() {} };
    }

    const furniturePalette = createFurniturePalette(app);
    const flipButton = furniturePalette.querySelector("[data-myroom-flip]");
    const deleteButton = furniturePalette.querySelector("[data-myroom-delete]");
    const state = createState();
    const images = {};
    const size = {
      cssWidth: 1,
      cssHeight: 1,
      pixelWidth: 1,
      pixelHeight: 1,
      dpr: 1,
    };

    let ready = false;
    let destroyed = false;
    let frameRequested = false;
    let resizeObserver = null;
    let activeDrag = null;
    let dragGhost = null;
    let cleanupTimer = null;

    gameRoot.textContent = "";
    gameRoot.appendChild(canvas);

    function requestRender() {
      if (!ready || destroyed || frameRequested) return;
      frameRequested = true;
      window.requestAnimationFrame(() => {
        frameRequested = false;
        if (destroyed) return;
        renderRoom(ctx, state, size, images);
        if (state.selectedObjectId) {
          requestRender();
        }
      });
    }

    function resize() {
      const rect = gameRoot.getBoundingClientRect();
      size.cssWidth = Math.max(1, rect.width);
      size.cssHeight = Math.max(1, rect.height);
      size.dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      size.pixelWidth = Math.round(size.cssWidth * size.dpr);
      size.pixelHeight = Math.round(size.cssHeight * size.dpr);

      if (canvas.width !== size.pixelWidth || canvas.height !== size.pixelHeight) {
        canvas.width = size.pixelWidth;
        canvas.height = size.pixelHeight;
      }
      canvas.style.width = `${size.cssWidth}px`;
      canvas.style.height = `${size.cssHeight}px`;
      requestRender();
    }

    function setGridVisible(value) {
      state.showGrid = value;
      gridButton?.classList.toggle("is-active", value);
      gridButton?.setAttribute("aria-pressed", String(value));
      requestRender();
    }

    function selectedObject() {
      return placedObjects.find((object) => object.uid === state.selectedObjectId) ?? null;
    }

    function updateFurnitureControls() {
      const hasSelection = Boolean(selectedObject());
      furniturePalette.classList.toggle("has-selection", hasSelection);
      if (flipButton instanceof HTMLButtonElement) {
        flipButton.disabled = !hasSelection;
      }
      if (deleteButton instanceof HTMLButtonElement) {
        deleteButton.disabled = !hasSelection;
      }
    }

    function setSelectedObject(object) {
      state.selectedObjectId = object?.uid ?? null;
      if (object) {
        state.selectedTile = {
          gridX: object.gridX,
          gridY: object.gridY,
          width: object.width ?? 1,
          depth: object.depth ?? 1,
        };
      } else {
        state.selectedTile = null;
      }
      updateFurnitureControls();
    }

    function flipSelectedFurniture() {
      const object = selectedObject();
      if (!object) return;

      object.flipped = !object.flipped;
      if (status) status.textContent = `${object.label} ${object.flipped ? "flipped" : "unflipped"}`;
      requestRender();
    }

    function deleteSelectedFurniture() {
      const object = selectedObject();
      if (!object) return;

      const index = placedObjects.findIndex((candidate) => candidate.uid === object.uid);
      if (index !== -1) {
        placedObjects.splice(index, 1);
      }
      state.selectedObjectId = null;
      state.selectedTile = null;
      updateFurnitureControls();
      if (status) status.textContent = `${object.label} deleted`;
      requestRender();
    }

    function createDragGhost(item) {
      const ghost = document.createElement("div");
      ghost.className = "myroom-drag-ghost";

      const image = document.createElement("img");
      image.src = item.sources[0];
      image.alt = "";
      ghost.appendChild(image);

      document.body.appendChild(ghost);
      return ghost;
    }

    function moveDragGhost(event) {
      if (!dragGhost) return;
      dragGhost.style.transform = `translate(${event.clientX + 14}px, ${event.clientY + 14}px)`;
    }

    function pointIsInsideCanvas(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    }

    function setDragPreviewFromPoint(clientX, clientY) {
      if (!pointIsInsideCanvas(clientX, clientY)) {
        state.dragPreviewTile = null;
        requestRender();
        return null;
      }

      const item = activeDrag?.type === "new" ? activeDrag.item : activeDrag?.object;
      if (!item) {
        state.dragPreviewTile = null;
        requestRender();
        return null;
      }

      const tile = screenPointToFurnitureGrid(canvas, state, clientX, clientY);
      state.dragPreviewTile = isFurnitureInsideRoom(tile, item)
        ? {
          ...tile,
          width: item.width ?? 1,
          depth: item.depth ?? 1,
        }
        : null;
      requestRender();
      return state.dragPreviewTile;
    }

    function placeFurniture(item, tile) {
      const imageElement = images.furniture?.[item.id];
      if (!imageElement) return;

      const object = {
        uid: `${item.id}-${nextObjectId++}`,
        itemId: item.id,
        label: item.label,
        gridX: tile.gridX,
        gridY: tile.gridY,
        width: item.width,
        depth: item.depth,
        drawWidth: item.drawWidth,
        drawHeight: item.drawHeight,
        anchorOffsetY: item.anchorOffsetY,
        crop: item.crop,
        imageElement,
        flipped: false,
      };
      placedObjects.push(object);
      state.selectedTile = tile;
      state.selectedObjectId = object.uid;
      updateFurnitureControls();
      if (status) status.textContent = `${item.label} placed at ${tile.gridX}, ${tile.gridY}`;
    }

    function moveFurniture(object, tile) {
      object.gridX = tile.gridX;
      object.gridY = tile.gridY;
      state.selectedTile = tile;
      state.selectedObjectId = object.uid;
      updateFurnitureControls();
      if (status) status.textContent = `${object.label} moved to ${tile.gridX}, ${tile.gridY}`;
    }

    function endFurnitureDrag(event) {
      if (!activeDrag) return;

      const tile = setDragPreviewFromPoint(event.clientX, event.clientY);
      if (tile && activeDrag.type === "new") {
        placeFurniture(activeDrag.item, tile);
      } else if (tile && activeDrag.type === "move" && activeDrag.moved) {
        moveFurniture(activeDrag.object, tile);
      } else if (activeDrag.type === "move") {
        setSelectedObject(activeDrag.object);
      }

      activeDrag = null;
      state.dragPreviewTile = null;
      app.classList.remove("is-dragging-furniture");
      dragGhost?.remove();
      dragGhost = null;
      try {
        canvas.releasePointerCapture?.(event.pointerId);
      } catch {
        // The canvas only captures move drags, not palette drags.
      }
      window.removeEventListener("pointermove", onFurnitureDragMove);
      window.removeEventListener("pointerup", onFurnitureDragEnd);
      window.removeEventListener("pointercancel", onFurnitureDragEnd);
      requestRender();
    }

    function onFurnitureDragMove(event) {
      if (!activeDrag) return;
      if (activeDrag.type === "new") {
        moveDragGhost(event);
      } else if (activeDrag.type === "move") {
        const distance = Math.abs(event.clientX - activeDrag.startX) + Math.abs(event.clientY - activeDrag.startY);
        if (distance > 3) activeDrag.moved = true;
      }
      setDragPreviewFromPoint(event.clientX, event.clientY);
    }

    function onFurnitureDragEnd(event) {
      endFurnitureDrag(event);
    }

    function startFurnitureDrag(item, event) {
      if (!ready) return;
      event.preventDefault();
      activeDrag = { type: "new", item };
      app.classList.add("is-dragging-furniture");
      dragGhost = createDragGhost(item);
      moveDragGhost(event);
      setGridVisible(true);
      setDragPreviewFromPoint(event.clientX, event.clientY);
      window.addEventListener("pointermove", onFurnitureDragMove);
      window.addEventListener("pointerup", onFurnitureDragEnd);
      window.addEventListener("pointercancel", onFurnitureDragEnd);
    }

    function onPalettePointerDown(event) {
      const target = event.target;
      const button = target instanceof Element ? target.closest("[data-furniture-id]") : null;
      if (!button) return;

      const item = FURNITURE_CATALOG.find((candidate) => candidate.id === button.dataset.furnitureId);
      if (!item) return;
      startFurnitureDrag(item, event);
    }

    function startPlacedFurnitureMove(object, event) {
      if (!ready) return;
      event.preventDefault();
      state.pointer.isDown = false;
      setSelectedObject(object);
      activeDrag = {
        type: "move",
        object,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
      app.classList.add("is-dragging-furniture");
      setGridVisible(true);
      setDragPreviewFromPoint(event.clientX, event.clientY);
      canvas.setPointerCapture?.(event.pointerId);
    }

    function selectTile(tile) {
      if (!isInsideRoom(tile)) return;
      state.selectedTile = tile;
      state.selectedObjectId = null;
      updateFurnitureControls();
      if (status) status.textContent = `selected ${tile.gridX}, ${tile.gridY}`;
      requestRender();
    }

    function onPointerDown(event) {
      if (activeDrag) return;

      const roomPoint = screenPointToRoom(canvas, state, event.clientX, event.clientY);
      const objectHit = findObjectAtRoomPoint(roomPoint.x, roomPoint.y);
      if (objectHit) {
        startPlacedFurnitureMove(objectHit, event);
        return;
      }

      state.pointer.isDown = true;
      state.pointer.moved = false;
      state.pointer.lastX = event.clientX;
      state.pointer.lastY = event.clientY;
      canvas.setPointerCapture?.(event.pointerId);
    }

    function onPointerMove(event) {
      if (activeDrag?.type === "move") {
        onFurnitureDragMove(event);
        return;
      }

      if (!state.pointer.isDown) return;
      const dx = event.clientX - state.pointer.lastX;
      const dy = event.clientY - state.pointer.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) state.pointer.moved = true;
      state.camera.x += dx;
      state.camera.y += dy;
      state.pointer.lastX = event.clientX;
      state.pointer.lastY = event.clientY;
      requestRender();
    }

    function onPointerUp(event) {
      if (activeDrag?.type === "move") {
        endFurnitureDrag(event);
        return;
      }

      const wasDrag = state.pointer.moved;
      state.pointer.isDown = false;
      canvas.releasePointerCapture?.(event.pointerId);
      if (!wasDrag) selectTile(screenPointToGrid(canvas, state, event.clientX, event.clientY));
    }

    function onWheel(event) {
      event.preventDefault();
      const oldZoom = state.camera.zoom;
      const nextZoom = clamp(
        oldZoom * (event.deltaY < 0 ? 1.08 : .92),
        ROOM_CONFIG.minZoom,
        ROOM_CONFIG.maxZoom,
      );
      state.camera.zoom = nextZoom;
      requestRender();
    }

    function toggleGrid() {
      setGridVisible(!state.showGrid);
    }

    function goBackToPack() {
      const brandButton = document.querySelector(".screen-room .brand-mark") || document.querySelector(".brand-mark");
      if (brandButton instanceof HTMLButtonElement && !brandButton.disabled) {
        brandButton.click();
      }
    }

    function showLoadError(error) {
      const message = document.createElement("div");
      message.className = "myroom-load-error";
      message.textContent = error.message;
      app.appendChild(message);
    }

    function destroy() {
      destroyed = true;
      activeDrag = null;
      dragGhost?.remove();
      dragGhost = null;
      if (cleanupTimer !== null) {
        window.clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onFurnitureDragMove);
      window.removeEventListener("pointerup", onFurnitureDragEnd);
      window.removeEventListener("pointercancel", onFurnitureDragEnd);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      furniturePalette.removeEventListener("pointerdown", onPalettePointerDown);
      flipButton?.removeEventListener("click", flipSelectedFurniture);
      deleteButton?.removeEventListener("click", deleteSelectedFurniture);
      furniturePalette.remove();
      gridButton?.removeEventListener("click", toggleGrid);
      backButton?.removeEventListener("click", goBackToPack);
    }

    furniturePalette.addEventListener("pointerdown", onPalettePointerDown);
    flipButton?.addEventListener("click", flipSelectedFurniture);
    deleteButton?.addEventListener("click", deleteSelectedFurniture);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    gridButton?.addEventListener("click", toggleGrid);
    backButton?.addEventListener("click", goBackToPack);

    if ("ResizeObserver" in window) {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(gameRoot);
    } else {
      window.addEventListener("resize", resize);
    }

    Promise.all([
      loadFirstImage(ROOM_CONFIG.assets.wallpaper),
      loadFirstImage(ROOM_CONFIG.assets.floorTile),
      loadFurnitureImages(),
    ])
      .then(([wallpaper, floorTile, furniture]) => {
        images.wallpaper = wallpaper;
        images.floorTile = floorTile;
        images.furniture = furniture;
        ready = true;
        resize();
      })
      .catch(showLoadError);

    cleanupTimer = window.setInterval(() => {
      if (!app.isConnected) {
        destroy();
      }
    }, 1000);

    return { destroy, requestRender, setGridVisible };
  }

  function bootRoomApps() {
    document.querySelectorAll("[data-myroom-app]").forEach((app) => {
      if (instances.has(app)) return;
      instances.set(app, createRoom(app));
    });
  }

  function start() {
    bootRoomApps();
    const root = document.getElementById("root") || document.body;
    new MutationObserver(bootRoomApps).observe(root, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }

  window.MyRoomIso = {
    ROOM_CONFIG,
    isoToScreen,
    placedObjects,
    renderObjects,
  };
})();
