/* 媒体预览功能 - 基于image-preview.js重构 */

// 立即执行函数，避免全局变量污染
(function() {
    // 配置常量
    const CONFIG = {
        CSS_PATH: '../image-preview.css', // CSS文件路径
        ZOOM: { // 缩放相关配置
            MIN: 0.8, // 最小缩放比例
            MAX: 5,   // 最大缩放比例
            STEP: 0.1 // 滚轮缩放步长
        },
        ANIMATION: { // 动画相关配置
            DURATION: 300, // 动画持续时间 (ms)
            TIMING: 'ease'   // 动画时间函数
        },
        DRAG: { // 拖拽相关配置
            THRESHOLD: 5,       // 判定为拖拽的最小移动像素
            CLOSE_THRESHOLD: 150, // 向下拖拽关闭模态框的最小距离 (px)
            HORIZONTAL_SWIPE_THRESHOLD: 100 // 水平拖动切换图片的最小距离 (px)
        },
        INERTIA: { // 惯性滚动配置
            DAMPING: 0.92,     // 阻尼系数 (越小越快停止)
            MIN_VELOCITY: 0.1 // 停止惯性动画的最小速度阈值
        },
        THUMBNAILS: { // 缩略图相关配置
            MARGIN: 50 // 每个幻灯片（Slide）右侧的间距 (px)
        },
        PINCH: { // 双指缩放相关配置
            MIN_CHANGE: 0.005,         // 判定为有效缩放变化的最小比例差
            MIN_POSITION_CHANGE: 0.5 // 判定为有效位置变化的最小像素差
        },
        IMAGE_SELECTORS: [ // 图片选择器及对应的描述属性
            { selector: '.image-carousel img', captionAttr: 'alt' }, // 选择器及其描述来源属性，按先后顺序组合
            { selector: '.Content-Type img', captionAttr: 'title' }
        ],
        ASPECT_RATIO_PRESETS: { // 缩略图宽高比预设
            portrait: '1/1',   // 竖向图片的预设比例
            landscape: '4/3'   // 横向图片的预设比例
        },
        DRAG_EFFECTS: { // 垂直拖拽关闭效果
            SCALE_MIN: 0.5,             // 向下拖动时的最小缩放比例
            SCALE_DISTANCE_FACTOR: 1000, // 计算缩放比例的距离除数 (越大变化越慢)
            OPACITY_MIN: 0.3,           // 向下拖动时背景最小透明度
            OPACITY_DISTANCE_FACTOR: 300, // 计算透明度的距离除数 (越大变化越慢)
            BLUR_MAX: 20,               // 向下拖动时背景最大模糊值 (px)
            BLUR_DISTANCE_FACTOR: 300,  // 计算模糊效果的距离除数 (越大变化越慢)
            BACKGROUND_RGB: '51, 51, 51', // 模态框背景RGB颜色
            BACKDROP_BLUR_BASE: 20      // 模态框背景基础模糊值 (px)
        }
    };

    // 状态管理器
    const createStore = (initialState) => {
        let state = initialState;
        const listeners = new Set();

        return {
            getState: () => state,
            setState: (newState) => {
                state = { ...state, ...newState };
                listeners.forEach(listener => listener(state));
            },
            subscribe: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            }
        };
    };

    // 主状态存储
    const store = createStore({
        currentImageIndex: 0,
        isZoomMode: false,
        isInitialLoad: true,
        currentZoomLevel: 1,
        zoomCurrentTranslateX: 0,
        zoomCurrentTranslateY: 0,
        isDragging: false,
        isVerticalDragging: false,
        isPinching: false,
        wasTouchingWithMultipleFingers: false
    });

    // DOM元素缓存
    const DOM = {
        modal: null,
        modalContent: null,
        slidesContainer: null,
        thumbnailsContainer: null,
        thumbnailsWrapper: null,
        captionContainer: null,
        images: [],
        slides: [],
        thumbnails: [],
        carouselImagesCount: 0, // 保留以防万一，但不再由 scanImages 直接设置
        imageSources: [] // 存储每个图片的来源配置
    };

    // 工具函数模块
    const Utils = {
        // 获取元素的translateX值
        getTranslateX(element) {
            const style = window.getComputedStyle(element);
            const matrix = new WebKitCSSMatrix(style.transform);
            return matrix.m41;
        },

        // 计算图片比例并缓存 (也处理异步加载情况)
        getImageAspectRatio(img, imageAspectRatios, images) {
            const imgIndex = images.indexOf(img);
            
            // 1. 检查缓存
            if (imageAspectRatios[imgIndex]) {
                return imageAspectRatios[imgIndex];
            }
            
            // 2. 检查图片是否已加载完成
            if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
                // 图片已加载完成，计算并缓存
                const imgWidth = img.naturalWidth;
                const imgHeight = img.naturalHeight;
                const isPortrait = imgWidth / imgHeight < 1;
                
                imageAspectRatios[imgIndex] = {
                    original: `${imgWidth} / ${imgHeight}`,
                    isPortrait: isPortrait,
                    preset: isPortrait ? CONFIG.ASPECT_RATIO_PRESETS.portrait : CONFIG.ASPECT_RATIO_PRESETS.landscape
                };
                return imageAspectRatios[imgIndex];
            } else {
                 // 3. 图片未加载完成或尺寸无效
                 // 返回 null 或 undefined，调用者需要处理这种情况 (例如通过 img.onload)
                 return null; 
            }
        },

        // 计算图片边界限制
        calculateImageBoundaries(img, zoom, currentZoomLevel, modalContent) {
            if (!img) return { allowHorizontal: false, allowVertical: false, bounds: { x: 0, y: 0 } };
            
            // 获取图片和slide容器的尺寸
            const rect = img.getBoundingClientRect();
            const slideContainer = img.closest('.img-preview-slide');
            const slideRect = slideContainer.getBoundingClientRect();
            
            // 计算缩放后的图片尺寸
            const scaledWidth = rect.width / currentZoomLevel * zoom;
            const scaledHeight = rect.height / currentZoomLevel * zoom;
            
            // 判断是否允许水平和垂直移动
            const allowHorizontal = scaledWidth > slideRect.width;
            const allowVertical = scaledHeight > slideRect.height;
            
            // 计算最大可移动范围（从中心点算起）
            const maxX = allowHorizontal ? Math.max(0, (scaledWidth - slideRect.width) / 2) : 0;
            const maxY = allowVertical ? Math.max(0, (scaledHeight - slideRect.height) / 2) : 0;
            
            return {
                allowHorizontal,
                allowVertical,
                bounds: { x: maxX, y: maxY }
            };
        }
    };

    // UI构建模块
    const UIBuilder = {
        // 创建预览模态框
        createModal() {
            // 创建模态框元素
            const modal = document.createElement('div');
            modal.className = 'img-preview-modal';
            const modalContent = document.createElement('div');
            modalContent.className = 'img-preview-content';
            // 添加缩略图容器
            const thumbnailsContainer = document.createElement('div');
            thumbnailsContainer.className = 'img-preview-thumbnails';
            // 添加标题栏容器
            const captionContainer = document.createElement('div');
            captionContainer.className = 'img-preview-caption-container';
            // 创建图片滑动容器
            const slidesContainer = document.createElement('div');
            slidesContainer.className = 'img-preview-slides';
            modalContent.appendChild(slidesContainer);
            modal.appendChild(captionContainer);
            modal.appendChild(modalContent);
            modal.appendChild(thumbnailsContainer);
            document.body.appendChild(modal);
            // 缓存DOM元素
            DOM.modal = modal;
            DOM.modalContent = modalContent;
            DOM.slidesContainer = slidesContainer;
            DOM.thumbnailsContainer = thumbnailsContainer;
            DOM.captionContainer = captionContainer;
        },
        // 创建预览幻灯片
        createSlides() {
            const images = DOM.images;
            const slidesContainer = DOM.slidesContainer;
            // 为每张图片创建独立的slide元素
            images.forEach((img, index) => {
                const slide = document.createElement('div');
                slide.className = 'img-preview-slide';
                slide.dataset.index = index;
                slide.style.marginRight = CONFIG.THUMBNAILS.MARGIN + 'px';
                const previewImg = document.createElement('img');
                previewImg.className = 'img-preview-img';
                previewImg.src = img.src;
                previewImg.draggable = false;
                // 保存描述文本到dataset
                let descriptionText = '';
                // 从 imageSources 获取对应的配置
                const sourceConfig = DOM.imageSources[index];
                if (sourceConfig && sourceConfig.captionAttr) {
                    descriptionText = img.getAttribute(sourceConfig.captionAttr);
                }
                // 将描述文本保存到slide的dataset中
                if (descriptionText && descriptionText.trim() !== '') {
                    slide.dataset.caption = descriptionText;
                }
                slide.appendChild(previewImg);
                slidesContainer.appendChild(slide);
                DOM.slides.push(slide);
            });
        },
        // 创建缩略图 (包含异步宽高比处理)
        createThumbnails() {
            const images = DOM.images;
            const thumbnailsContainer = DOM.thumbnailsContainer;
            const imageAspectRatios = ImagePreview.imageAspectRatios; // 使用缓存对象
            
            // 创建缩略图容器
            const thumbnailsWrapper = document.createElement('div');
            thumbnailsWrapper.className = 'img-preview-thumbnails-wrapper';
            DOM.thumbnailsWrapper = thumbnailsWrapper; // 缓存容器

            images.forEach((img, index) => {
                const thumbnail = document.createElement('img');
                thumbnail.src = img.src;
                thumbnail.className = 'img-preview-thumbnail';
                thumbnail.dataset.index = index;
                thumbnail.draggable = false; // 禁用默认拖拽

                // --- 异步处理宽高比 ---
                const setAspectRatio = (aspectRatioData) => {
                    if (aspectRatioData && aspectRatioData.preset) {
                        thumbnail.style.aspectRatio = aspectRatioData.preset;
                    } else {
                        // 如果数据无效，使用默认值
                        thumbnail.style.aspectRatio = CONFIG.ASPECT_RATIO_PRESETS.landscape; 
                    }
                };

                // 尝试直接获取宽高比 (处理已缓存或已加载完成的图片)
                const initialAspectRatio = Utils.getImageAspectRatio(img, imageAspectRatios, images);
                if (initialAspectRatio) {
                    setAspectRatio(initialAspectRatio); // 如果已有数据，立即设置
                } else {
                    // 如果图片未加载完成 (Utils.getImageAspectRatio 返回 undefined 或 null)
                    // 设置一个临时/默认宽高比
                     thumbnail.style.aspectRatio = CONFIG.ASPECT_RATIO_PRESETS.landscape; // 或 '1/1'

                    // 添加 onload 事件监听器，在图片加载完成后更新宽高比
                    img.onload = () => {
                        const loadedAspectRatio = Utils.getImageAspectRatio(img, imageAspectRatios, images);
                        setAspectRatio(loadedAspectRatio);
                        img.onload = null; // 清理监听器，避免内存泄漏
                    };
                    // 可选：添加onerror处理，以防图片加载失败
                    img.onerror = () => {
                         setAspectRatio(null); // 使用默认值
                         img.onerror = null;
                    }
                }
                // --- 结束异步处理 ---

                thumbnailsWrapper.appendChild(thumbnail);
                DOM.thumbnails.push(thumbnail); // 缓存缩略图DOM元素
            });
            thumbnailsContainer.appendChild(thumbnailsWrapper);
        }
    };

    // 核心功能模块
    const ImagePreview = {
        // 存储图片比例信息的缓存对象
        imageAspectRatios: {},
        // 状态追踪变量
        drag: {
            startX: 0,
            startY: 0,
            startTranslate: 0,
            verticalTranslate: 0,
            verticalDistance: 0,
            isModalContentDragging: false,
            modalContentStartX: 0,
            modalContentStartY: 0,
            hasDragged: false,
            isThumbDragging: false,
            scrollLeft: 0
        },
        zoom: {
            zoomDragging: false,
            zoomStartX: 0,
            zoomStartY: 0,
            initialPinchDistance: 0,
            pinchStartZoom: 1,
            pinchStartTranslateX: 0,
            pinchStartTranslateY: 0,
            initialTouchMidpoint: { x: 0, y: 0 },
            initialImagePosition: { x: 0, y: 0 },
            lastTouchMidpoint: { x: 0, y: 0 },
            lastPinchRatio: 1,
            smoothingFactor: 0.3,
            animationFrameId: null,
            pendingTransform: null
        },
        inertia: {
            lastMoveTime: 0,
            lastPosX: 0,
            lastPosY: 0,
            velocityX: 0,
            velocityY: 0,
            inertiaFrameId: null
        },
        // 初始化
        init() {
            this.loadCSS();
            this.scanImages(); // 扫描获取图片列表

            // 提前创建基础UI结构
            UIBuilder.createModal();
            UIBuilder.createSlides();

            // **重要：提前绑定图片点击事件，实现早期可交互**
            this.bindImageClickEvents(); 

            // 创建缩略图（包含异步处理宽高比）
            UIBuilder.createThumbnails(); 

            // 绑定其他核心事件
            this.bindModalEvents();
            this.bindThumbnailEvents(); // 缩略图交互事件（点击、拖动）
            this.bindDragEvents();      // 主要预览区域拖动事件
            this.bindZoomEvents();      // 缩放相关事件
            this.bindKeyboardEvents();  // 键盘导航
            this.bindResizeEvents();    // 窗口大小调整

            // 初始化双击处理
            DoubleClickZoomHandler.init(); 
        },
        // 加载CSS样式
        loadCSS() {
            const cssLink = document.createElement('link');
            cssLink.href = CONFIG.CSS_PATH;
            cssLink.rel = 'stylesheet';
            cssLink.media = 'screen';
            cssLink.type = 'text/css';
            document.head.appendChild(cssLink);
        },
        // 扫描页面图片
        scanImages() {
            DOM.images = [];
            DOM.imageSources = []; 
            CONFIG.IMAGE_SELECTORS.forEach((config) => {
                const images = Array.from(document.querySelectorAll(config.selector));
                DOM.images = DOM.images.concat(images);
                // 为每个找到的图片存储其来源配置
                images.forEach(() => {
                    DOM.imageSources.push(config);
                });
            });
        },

        // 绑定模态框事件
        bindModalEvents() {
            const modalContent = DOM.modalContent;
            // 点击模态框内容区域关闭预览
            modalContent.addEventListener('mousedown', (e) => {
                this.drag.modalContentStartX = e.clientX;
                this.drag.modalContentStartY = e.clientY;
                this.drag.isModalContentDragging = false;
            });
            modalContent.addEventListener('mousemove', (e) => {
                if (Math.abs(e.clientX - this.drag.modalContentStartX) > CONFIG.DRAG.THRESHOLD || 
                    Math.abs(e.clientY - this.drag.modalContentStartY) > CONFIG.DRAG.THRESHOLD) {
                    this.drag.isModalContentDragging = true;
                }
            });
            modalContent.addEventListener('click', (e) => {
                // 如果点击目标是图片本身（由DoubleClickZoomHandler处理）或正在拖拽，则不关闭
                if (e.target.classList.contains('img-preview-img') || this.drag.isModalContentDragging) {
                    return;
                }
                const state = store.getState();
                // 如果未处于放大模式且未拖拽，则关闭模态框
                if (!state.isZoomMode) {
                    this.closeModal();
                }
            });
            // 触摸事件支持
            modalContent.addEventListener('touchstart', (e) => {
                // 阻止默认行为（如页面滚动），但不执行其他操作
                // 注意：如果目标是图片，触摸事件也可能由 DoubleClickZoomHandler 处理
                e.preventDefault();
                if (e.touches.length === 1) {
                    this.drag.modalContentStartX = e.touches[0].clientX;
                    this.drag.modalContentStartY = e.touches[0].clientY;
                    this.drag.isModalContentDragging = false;
                }
            }, { passive: false });
            modalContent.addEventListener('touchmove', (e) => {
                if (e.touches.length === 1) {
                    if (Math.abs(e.touches[0].clientX - this.drag.modalContentStartX) > CONFIG.DRAG.THRESHOLD || 
                        Math.abs(e.touches[0].clientY - this.drag.modalContentStartY) > CONFIG.DRAG.THRESHOLD) {
                        this.drag.isModalContentDragging = true;
                    }
                }
            }, { passive: true });
            modalContent.addEventListener('touchend', (e) => {
                 // 如果触摸结束的目标是图片本身（由DoubleClickZoomHandler处理），则不关闭
                if (e.target.classList.contains('img-preview-img')) {
                    // 如果所有手指都离开屏幕，确保重置多点触摸标志
                    if (e.touches.length === 0) {
                         store.setState({ wasTouchingWithMultipleFingers: false });
                    }
                    return;
                }
                const state = store.getState();
                // 如果未处于放大模式，未拖拽，是单点触摸结束，且之前不是多点触摸，则关闭模态框
                if (!state.isZoomMode && !this.drag.isModalContentDragging &&
                    e.touches.length === 0 && !state.wasTouchingWithMultipleFingers) {
                    this.closeModal();
                }
                // 只有当所有手指都离开屏幕时，才重置多点触摸标志
                if (e.touches.length === 0) {
                    store.setState({ wasTouchingWithMultipleFingers: false });
                }
            });
        },

        // 绑定缩略图事件 (主要是容器拖动和缩略图点击切换)
        bindThumbnailEvents() {
            const thumbnailsContainer = DOM.thumbnailsContainer;
            const thumbnails = DOM.thumbnails;
            const thumbnailsWrapper = DOM.thumbnailsWrapper;
            // 添加缩略图拖动功能
            thumbnailsContainer.addEventListener('mousedown', (e) => {
                this.drag.isThumbDragging = true;
                this.drag.hasDragged = false;
                thumbnailsContainer.classList.add('grabbing');
                thumbnailsContainer.style.scrollBehavior = 'auto'; // 拖拽时禁用平滑滚动
                this.drag.startX = e.clientX;
                this.drag.scrollLeft = thumbnailsContainer.scrollLeft;
            });
            document.addEventListener('mousemove', (e) => {
                if (!this.drag.isThumbDragging) return;
                e.preventDefault();
                const x = e.clientX;
                const walk = x - this.drag.startX;
                if (Math.abs(walk) > CONFIG.DRAG.THRESHOLD) { // 添加一个小的阈值，只有移动超过5像素才被认为是拖动
                    this.drag.hasDragged = true;
                }
                thumbnailsContainer.scrollLeft = this.drag.scrollLeft - walk;
            });
            document.addEventListener('mouseup', () => {
                this.drag.isThumbDragging = false;
                thumbnailsContainer.classList.remove('grabbing');
                thumbnailsContainer.style.scrollBehavior = 'smooth'; // 拖拽结束后恢复平滑滚动
            });
            document.addEventListener('mouseleave', () => {
                this.drag.isThumbDragging = false;
                thumbnailsContainer.classList.remove('grabbing');
            });
            // 添加缩略图点击切换功能
            thumbnails.forEach(thumbnail => {
                thumbnail.addEventListener('click', (e) => {
                    if (!this.drag.hasDragged) {
                        const index = parseInt(thumbnail.dataset.index);
                        this.showImage(index);
                    }
                });
            });
        },

        // 绑定拖拽事件 (主预览区域)
        bindDragEvents() {
            const slidesContainer = DOM.slidesContainer;
            const modal = DOM.modal;
            const modalContent = DOM.modalContent;
            const thumbnailsContainer = DOM.thumbnailsContainer;
            const captionContainer = DOM.captionContainer;
            
            // 处理幻灯片容器的鼠标拖拽
            slidesContainer.addEventListener('mousedown', (e) => {
                const state = store.getState();
                if (!modal.classList.contains('active')) return;
                
                // 放大模式下的拖动由ZoomHandler处理
                if (state.isZoomMode) return;

                store.setState({ isDragging: true, isVerticalDragging: false });
                this.drag.startX = e.clientX;
                this.drag.startY = e.clientY;
                this.drag.startTranslate = Utils.getTranslateX(slidesContainer);
                this.drag.verticalTranslate = 0;
                slidesContainer.style.transition = 'none';
            });
            
            document.addEventListener('mousemove', (e) => {
                const state = store.getState();
                
                // 处理幻灯片容器的拖拽
                if (!state.isDragging) return;
                
                // 放大模式下不允许拖动切换/关闭
                if (state.isZoomMode) return;

                const x = e.clientX;
                const y = e.clientY;
                const diffX = x - this.drag.startX;
                const diffY = y - this.drag.startY;
                
                // 判断拖动方向
                if (!state.isVerticalDragging && Math.abs(diffY) > Math.abs(diffX)) {
                    // 垂直拖动且角度大于45度
                    store.setState({ isVerticalDragging: true });
                    slidesContainer.classList.add('vertical-dragging');
                    
                    // 仅在向下拖动时隐藏缩略图和标题
                    if (diffY > 0) {
                        thumbnailsContainer.classList.add('img-preview-hidden');
                        captionContainer.classList.add('img-preview-hidden');
                    }
                }
                
                if (state.isVerticalDragging) {
                    // 垂直拖动 - 始终跟随鼠标移动
                    this.drag.verticalDistance = diffY;
                    
                    // 获取当前显示的图片
                    const activeImg = slidesContainer.querySelector(`.img-preview-slide[data-index="${state.currentImageIndex}"] .img-preview-img`);
                    
                    // 图片位置始终跟随鼠标移动
                    if (diffY > 0) {
                        // 向下拖动时，应用缩放和透明度变化效果
                        const scale = Math.max(CONFIG.DRAG_EFFECTS.SCALE_MIN, 1 - diffY / CONFIG.DRAG_EFFECTS.SCALE_DISTANCE_FACTOR);
                        const blurValue = Math.max(0, CONFIG.DRAG_EFFECTS.BACKDROP_BLUR_BASE - (diffY / CONFIG.DRAG_EFFECTS.BLUR_DISTANCE_FACTOR) * CONFIG.DRAG_EFFECTS.BLUR_MAX);
                        const opacity = Math.max(CONFIG.DRAG_EFFECTS.OPACITY_MIN, 1 - diffY / CONFIG.DRAG_EFFECTS.OPACITY_DISTANCE_FACTOR);
                        
                        // 应用位移和缩放
                        activeImg.style.transform = `translate(${diffX}px, ${diffY}px) scale(${scale})`;
                        
                        // 调整模态框透明度和模糊效果
                        modal.style.backgroundColor = `rgba(${CONFIG.DRAG_EFFECTS.BACKGROUND_RGB}, ${opacity})`;
                        const blurStyle = `blur(${blurValue}px)`;
                        modal.style.backdropFilter = blurStyle;
                        modal.style.webkitBackdropFilter = blurStyle;
                        
                        // 向下拖动时隐藏缩略图和标题（确保动态响应方向变化）
                        thumbnailsContainer.classList.add('img-preview-hidden');
                        captionContainer.classList.add('img-preview-hidden');
                    } else {
                        // 向上拖动时，只应用位移，不改变其他效果
                        activeImg.style.transform = `translate(${diffX}px, ${diffY}px)`;
                        
                        // 保持背景不变
                        modal.style.backgroundColor = `rgba(${CONFIG.DRAG_EFFECTS.BACKGROUND_RGB}, 1)`;
                        const baseBlurStyle = `blur(${CONFIG.DRAG_EFFECTS.BACKDROP_BLUR_BASE}px)`;
                        modal.style.backdropFilter = baseBlurStyle;
                        modal.style.webkitBackdropFilter = baseBlurStyle;
                        
                        // 向上拖动时保持缩略图和标题可见
                        thumbnailsContainer.classList.remove('img-preview-hidden');
                        captionContainer.classList.remove('img-preview-hidden');
                    }
                    
                    activeImg.style.transformOrigin = 'center';
                    this.drag.verticalTranslate = this.drag.verticalDistance;
                } else {
                    // 水平拖动 - 切换图片
                    slidesContainer.style.transform = `translateX(${this.drag.startTranslate + diffX}px)`;
                }
            });
            
            document.addEventListener('mouseup', (e) => {
                const state = store.getState();
                
                if (!state.isDragging) return;
                DragHandler.handleDragEnd(this.drag.verticalDistance, state.isVerticalDragging);
            });
            
            // 触摸滑动支持
            slidesContainer.addEventListener('touchstart', (e) => {
                const state = store.getState();
                if (!modal.classList.contains('active')) return;
                
                // 放大模式下的触摸拖拽由ZoomHandler处理
                if (state.isZoomMode) {
                    if (e.touches.length === 1) {
                        // 停止正在进行的惯性动画
                        if (this.inertia.inertiaFrameId) {
                            cancelAnimationFrame(this.inertia.inertiaFrameId);
                            this.inertia.inertiaFrameId = null;
                        }
                        
                        this.zoom.zoomDragging = true;
                        this.zoom.zoomStartX = e.touches[0].clientX;
                        this.zoom.zoomStartY = e.touches[0].clientY;
                        
                        // 初始化惯性追踪变量
                        this.inertia.velocityX = 0;
                        this.inertia.velocityY = 0;
                        this.inertia.lastPosX = this.zoom.zoomStartX;
                        this.inertia.lastPosY = this.zoom.zoomStartY;
                        this.inertia.lastMoveTime = performance.now();
                    }
                    return; // 在缩放模式下，不进行普通拖拽初始化
                }
                
                if (e.touches.length === 1) {
                    store.setState({ isDragging: true, isVerticalDragging: false });
                    this.drag.startX = e.touches[0].clientX;
                    this.drag.startY = e.touches[0].clientY;
                    this.drag.startTranslate = Utils.getTranslateX(slidesContainer);
                    this.drag.verticalTranslate = 0;
                    slidesContainer.style.transition = 'none';
                }
                
                // 解决iOS Safari触摸事件问题
                e.preventDefault();
            }, { passive: false });
            
            slidesContainer.addEventListener('touchmove', (e) => {
                const state = store.getState();
                
                // 在缩放模式下，拖动由 ZoomHandler 处理，这里直接返回
                if (!state.isDragging || state.isPinching || state.isZoomMode) return;
                
                const x = e.touches[0].clientX;
                const y = e.touches[0].clientY;
                const diffX = x - this.drag.startX;
                const diffY = y - this.drag.startY;
                
                // 判断拖动方向
                if (!state.isVerticalDragging && Math.abs(diffY) > Math.abs(diffX)) {
                    // 垂直拖动且角度大于45度
                    store.setState({ isVerticalDragging: true });
                    slidesContainer.classList.add('vertical-dragging');
                    
                    // 仅在向下拖动时隐藏缩略图和标题
                    if (diffY > 0) {
                        thumbnailsContainer.classList.add('img-preview-hidden');
                        captionContainer.classList.add('img-preview-hidden');
                    }
                }
                
                if (state.isVerticalDragging) {
                    // 垂直拖动 - 始终跟随手指移动
                    this.drag.verticalDistance = diffY;
                    
                    // 获取当前显示的图片
                    const activeImg = slidesContainer.querySelector(`.img-preview-slide[data-index="${state.currentImageIndex}"] .img-preview-img`);
                    
                    // 图片位置始终跟随手指移动
                    if (diffY > 0) {
                        // 向下拖动时，应用缩放和透明度变化效果
                        const scale = Math.max(CONFIG.DRAG_EFFECTS.SCALE_MIN, 1 - diffY / CONFIG.DRAG_EFFECTS.SCALE_DISTANCE_FACTOR);
                        const blurValue = Math.max(0, CONFIG.DRAG_EFFECTS.BACKDROP_BLUR_BASE - (diffY / CONFIG.DRAG_EFFECTS.BLUR_DISTANCE_FACTOR) * CONFIG.DRAG_EFFECTS.BLUR_MAX);
                        const opacity = Math.max(CONFIG.DRAG_EFFECTS.OPACITY_MIN, 1 - diffY / CONFIG.DRAG_EFFECTS.OPACITY_DISTANCE_FACTOR);
                        
                        // 应用位移和缩放
                        activeImg.style.transform = `translate(${diffX}px, ${diffY}px) scale(${scale})`;
                        
                        // 调整模态框透明度和模糊效果
                        modal.style.backgroundColor = `rgba(${CONFIG.DRAG_EFFECTS.BACKGROUND_RGB}, ${opacity})`;
                        const blurStyle = `blur(${blurValue}px)`;
                        modal.style.backdropFilter = blurStyle;
                        modal.style.webkitBackdropFilter = blurStyle;
                        
                        // 向下拖动时隐藏缩略图和标题（确保动态响应方向变化）
                        thumbnailsContainer.classList.add('img-preview-hidden');
                        captionContainer.classList.add('img-preview-hidden');
                    } else {
                        // 向上拖动时，只应用位移，不改变其他效果
                        activeImg.style.transform = `translate(${diffX}px, ${diffY}px)`;
                        
                        // 保持背景不变
                        modal.style.backgroundColor = `rgba(${CONFIG.DRAG_EFFECTS.BACKGROUND_RGB}, 1)`;
                        const baseBlurStyle = `blur(${CONFIG.DRAG_EFFECTS.BACKDROP_BLUR_BASE}px)`;
                        modal.style.backdropFilter = baseBlurStyle;
                        modal.style.webkitBackdropFilter = baseBlurStyle;
                        
                        // 向上拖动时保持缩略图和标题可见
                        thumbnailsContainer.classList.remove('img-preview-hidden');
                        captionContainer.classList.remove('img-preview-hidden');
                    }
                    
                    activeImg.style.transformOrigin = 'center';
                    this.drag.verticalTranslate = this.drag.verticalDistance;
                } else {
                    // 水平拖动 - 切换图片
                    slidesContainer.style.transform = `translateX(${this.drag.startTranslate + diffX}px)`;
                }
                
                // 阻止页面滚动，确保触摸滑动事件被正确处理
                e.preventDefault();
            }, { passive: false });
            
            // 处理触摸结束事件
            slidesContainer.addEventListener('touchend', (e) => {
                const state = store.getState();
                
                // 处理拖拽结束，但不处理缩放相关操作 (添加 isZoomMode 检查)
                if (state.isDragging && !state.isPinching && !state.isZoomMode) {
                    DragHandler.handleDragEnd(this.drag.verticalDistance, state.isVerticalDragging);
                }
            });
            
            // 处理触摸取消事件
            slidesContainer.addEventListener('touchcancel', (e) => {
                const state = store.getState();
                
                // 处理拖拽取消，但不处理缩放相关操作 (添加 isZoomMode 检查)
                if (state.isDragging && !state.isPinching && !state.isZoomMode) {
                    DragHandler.handleDragEnd(this.drag.verticalDistance, state.isVerticalDragging);
                }
            });
        },

        // 绑定缩放事件
        bindZoomEvents() {
            const slidesContainer = DOM.slidesContainer;
            const modalContent = DOM.modalContent;
            
            // 滚轮缩放
            slidesContainer.addEventListener('wheel', (e) => {
                ZoomHandler.handleWheelZoom(e);
            }, { passive: false });
            
            // 鼠标拖动缩放后的图片
            slidesContainer.addEventListener('mousedown', (e) => {
                const state = store.getState();
                if (!state.isZoomMode || !DOM.modal.classList.contains('active')) return;
                
                e.preventDefault();
                
                this.zoom.zoomDragging = true;
                this.zoom.zoomStartX = e.clientX;
                this.zoom.zoomStartY = e.clientY;
                
                // 初始化惯性追踪变量
                this.inertia.velocityX = 0;
                this.inertia.velocityY = 0;
                this.inertia.lastPosX = e.clientX;
                this.inertia.lastPosY = e.clientY;
                this.inertia.lastMoveTime = performance.now();
                
                // 更改鼠标样式为抓取状态
                modalContent.style.cursor = 'grabbing';
            });
            
            document.addEventListener('mousemove', (e) => {
                if (!this.zoom.zoomDragging) return;
                ZoomHandler.handleZoomDrag(e, false);
            });
            
            document.addEventListener('mouseup', (e) => {
                if (!this.zoom.zoomDragging) return;
                
                this.zoom.zoomDragging = false;
                
                const state = store.getState();
                // 启动惯性动画
                if (Math.abs(this.inertia.velocityX) > CONFIG.INERTIA.MIN_VELOCITY || 
                    Math.abs(this.inertia.velocityY) > CONFIG.INERTIA.MIN_VELOCITY) {
                    InertiaHandler.startInertiaAnimation();
                } else {
                    // 如果速度不够，确保光标恢复
                    if (state.isZoomMode) {
                        modalContent.style.cursor = 'grab';
                    }
                }
            });
            
            // 确保鼠标离开窗口时也能结束拖拽并触发惯性
            document.addEventListener('mouseleave', () => {
                if (!this.zoom.zoomDragging) return;
                
                this.zoom.zoomDragging = false;
                
                // 启动惯性动画
                if (Math.abs(this.inertia.velocityX) > CONFIG.INERTIA.MIN_VELOCITY || 
                    Math.abs(this.inertia.velocityY) > CONFIG.INERTIA.MIN_VELOCITY) {
                    InertiaHandler.startInertiaAnimation();
                } else {
                    const state = store.getState();
                    // 如果速度不够，确保光标恢复
                    if (state.isZoomMode) {
                        modalContent.style.cursor = 'grab';
                    }
                }
            });
            
            // 添加双指缩放支持
            slidesContainer.addEventListener('touchstart', (e) => {
                if (!DOM.modal.classList.contains('active')) return;
                
                // 检测是否为双指缩放
                if (e.touches.length === 2) {
                    e.preventDefault();
                    
                    // 启动双指缩放模式
                    store.setState({ isPinching: true });
                    
                    // 计算两个触摸点之间的初始距离
                    const touch1 = e.touches[0];
                    const touch2 = e.touches[1];
                    this.zoom.initialPinchDistance = Math.hypot(
                        touch2.clientX - touch1.clientX,
                        touch2.clientY - touch1.clientY
                    );

                    const state = store.getState();
                    // 获取当前图片元素和其位置信息
                    const activeImg = slidesContainer.querySelector(`.img-preview-slide[data-index="${state.currentImageIndex}"] .img-preview-img`);
                    const rect = activeImg.getBoundingClientRect();

                    // 记录初始图片的变换状态
                    this.zoom.pinchStartZoom = state.currentZoomLevel;
                    this.zoom.pinchStartTranslateX = state.zoomCurrentTranslateX;
                    this.zoom.pinchStartTranslateY = state.zoomCurrentTranslateY;

                    // 计算初始双指中点在屏幕上的坐标
                    this.zoom.initialTouchMidpoint = {
                        x: (touch1.clientX + touch2.clientX) / 2,
                        y: (touch1.clientY + touch2.clientY) / 2
                    };
                    
                    // 重置平滑处理变量
                    this.zoom.lastTouchMidpoint = { ...this.zoom.initialTouchMidpoint };
                    this.zoom.lastPinchRatio = 1;

                    // 记录图片初始位置（中心点坐标）
                    this.zoom.initialImagePosition = {
                        x: rect.left + rect.width / 2,
                        y: rect.top + rect.height / 2
                    };
                }
                // 放大模式下的单指拖拽的处理已移至bindDragEvents中
            }, { passive: false });
            
            slidesContainer.addEventListener('touchmove', (e) => {
                const state = store.getState();
                
                // 处理双指缩放
                if (state.isPinching && e.touches.length === 2) {
                    e.preventDefault();
                    
                    // 获取当前双指距离
                    const touch1 = e.touches[0];
                    const touch2 = e.touches[1];
                    const currentDistance = Math.hypot(
                        touch2.clientX - touch1.clientX,
                        touch2.clientY - touch1.clientY
                    );
                    
                    // 计算缩放比例变化
                    const pinchRatio = currentDistance / this.zoom.initialPinchDistance;
                    
                    // 平滑处理缩放比例
                    const smoothedPinchRatio = this.zoom.lastPinchRatio + (pinchRatio - this.zoom.lastPinchRatio) * this.zoom.smoothingFactor;
                    
                    // 如果变化太小，保持上次的比例
                    const isPinchChangeSufficient = Math.abs(smoothedPinchRatio - this.zoom.lastPinchRatio) >= CONFIG.PINCH.MIN_CHANGE;
                    const effectivePinchRatio = isPinchChangeSufficient ? 
                        smoothedPinchRatio : this.zoom.lastPinchRatio;
                    
                    // 更新上次缩放比例
                    this.zoom.lastPinchRatio = isPinchChangeSufficient ? 
                        smoothedPinchRatio : this.zoom.lastPinchRatio;
                    
                    // 新的缩放级别 = 开始缩放时的级别 * 手指距离比例
                    // 允许临时缩放至小于100%，但最小不低于CONFIG.ZOOM.MIN
                    let newZoom = this.zoom.pinchStartZoom * effectivePinchRatio;
                    newZoom = Math.max(CONFIG.ZOOM.MIN, Math.min(newZoom, CONFIG.ZOOM.MAX));
                    
                    // 获取当前图片元素
                    const activeImg = slidesContainer.querySelector(
                        `.img-preview-slide[data-index="${state.currentImageIndex}"] .img-preview-img`
                    );
                    if (!activeImg) return;
                    
                    // 原始双指中点计算
                    const rawTouchMidpoint = {
                        x: (touch1.clientX + touch2.clientX) / 2,
                        y: (touch1.clientY + touch2.clientY) / 2
                    };
                    
                    // 平滑处理触摸中点
                    const currentTouchMidpoint = {
                        x: this.zoom.lastTouchMidpoint.x + (rawTouchMidpoint.x - this.zoom.lastTouchMidpoint.x) * this.zoom.smoothingFactor,
                        y: this.zoom.lastTouchMidpoint.y + (rawTouchMidpoint.y - this.zoom.lastTouchMidpoint.y) * this.zoom.smoothingFactor
                    };
                    
                    // 更新上次触摸中点
                    this.zoom.lastTouchMidpoint = { ...currentTouchMidpoint };
                    
                    // 获取图片尺寸
                    const imageRect = activeImg.getBoundingClientRect();
                    
                    // 计算手指中点相对于当前图片中心的位置向量
                    const imgCenterX = imageRect.left + imageRect.width / 2;
                    const imgCenterY = imageRect.top + imageRect.height / 2;
                    
                    // 计算向量，从图片中心指向触摸中点
                    const vectorX = currentTouchMidpoint.x - imgCenterX;
                    const vectorY = currentTouchMidpoint.y - imgCenterY;
                    
                    // 计算这个向量相对于图片宽高的比例
                    const relativeX = vectorX / (imageRect.width / 2);
                    const relativeY = vectorY / (imageRect.height / 2);
                    
                    // 计算缩放前后的图片物理尺寸变化
                    const preScaledWidth = imageRect.width / state.currentZoomLevel;
                    const preScaledHeight = imageRect.height / state.currentZoomLevel;
                    const newScaledWidth = preScaledWidth * newZoom;
                    const newScaledHeight = preScaledHeight * newZoom;
                    const deltaWidth = newScaledWidth - imageRect.width;
                    const deltaHeight = newScaledHeight - imageRect.height;
                    
                    // 考虑手指中点移动
                    const midpointDeltaX = currentTouchMidpoint.x - this.zoom.initialTouchMidpoint.x;
                    const midpointDeltaY = currentTouchMidpoint.y - this.zoom.initialTouchMidpoint.y;
                    
                    // 计算缩放补偿
                    const scaleCompensationX = -deltaWidth * relativeX * 0.5;
                    const scaleCompensationY = -deltaHeight * relativeY * 0.5;
                    
                    // 结合手指移动和缩放补偿计算最终位置
                    let newTranslateX = this.zoom.pinchStartTranslateX + midpointDeltaX + scaleCompensationX;
                    let newTranslateY = this.zoom.pinchStartTranslateY + midpointDeltaY + scaleCompensationY;
                    
                    // 获取可移动边界信息
                    const boundaries = Utils.calculateImageBoundaries(activeImg, newZoom, state.currentZoomLevel, modalContent);
                    
                    // 智能边界限制
                    if (newZoom > 1) {
                        // 只有当允许水平移动时才限制X轴
                        if (boundaries.allowHorizontal) {
                            newTranslateX = Math.max(-boundaries.bounds.x, Math.min(boundaries.bounds.x, newTranslateX));
                        } else {
                            // 不允许水平移动时强制居中
                            newTranslateX = 0;
                        }
                        
                        // 只有当允许垂直移动时才限制Y轴
                        if (boundaries.allowVertical) {
                            newTranslateY = Math.max(-boundaries.bounds.y, Math.min(boundaries.bounds.y, newTranslateY));
                        } else {
                            // 不允许垂直移动时强制居中
                            newTranslateY = 0;
                        }
                    }
                    
                    // 判断位置是否有明显变化
                    let needsUpdate = Math.abs(newZoom - state.currentZoomLevel) >= CONFIG.PINCH.MIN_CHANGE ||
                            Math.abs(newTranslateX - state.zoomCurrentTranslateX) >= CONFIG.PINCH.MIN_POSITION_CHANGE ||
                            Math.abs(newTranslateY - state.zoomCurrentTranslateY) >= CONFIG.PINCH.MIN_POSITION_CHANGE;
                    
                    // 使用requestAnimationFrame优化渲染
                    if (needsUpdate && activeImg) {
                        // 更新状态
                        store.setState({
                            currentZoomLevel: newZoom,
                            zoomCurrentTranslateX: newTranslateX,
                            zoomCurrentTranslateY: newTranslateY
                        });
                        
                        // 取消之前的动画帧请求
                        if (this.zoom.animationFrameId) {
                            cancelAnimationFrame(this.zoom.animationFrameId);
                        }
                        
                        // 存储变换信息以在下一帧应用
                        this.zoom.pendingTransform = {
                            translateX: newTranslateX,
                            translateY: newTranslateY,
                            zoom: newZoom
                        };
                        
                        // 请求新的动画帧
                        this.zoom.animationFrameId = requestAnimationFrame(() => {
                            if (this.zoom.pendingTransform && activeImg) {
                                activeImg.style.transform = `translate(${this.zoom.pendingTransform.translateX}px, ${this.zoom.pendingTransform.translateY}px) scale(${this.zoom.pendingTransform.zoom})`;
                                // 启用硬件加速
                                activeImg.style.willChange = 'transform';
                                this.zoom.pendingTransform = null;
                            }
                        });
                    }
                } else if (this.zoom.zoomDragging && state.isZoomMode && e.touches.length === 1) {
                    // 放大模式下的触摸拖拽
                    e.preventDefault(); // 确保不会触发浏览器默认行为
                    ZoomHandler.handleZoomDrag(e, true);
                } else if (state.isZoomMode && e.touches.length === 1) {
                    // 确保即使未正确设置zoomDragging，但处于缩放模式时也能响应拖拽
                    e.preventDefault();
                    // 模拟开始拖拽
                    if (!this.zoom.zoomDragging) {
                        this.zoom.zoomDragging = true;
                        this.zoom.zoomStartX = e.touches[0].clientX;
                        this.zoom.zoomStartY = e.touches[0].clientY;
                        this.inertia.lastPosX = e.touches[0].clientX;
                        this.inertia.lastPosY = e.touches[0].clientY;
                        this.inertia.lastMoveTime = performance.now();
                    }
                    ZoomHandler.handleZoomDrag(e, true);
                }
            }, { passive: false });
            
            slidesContainer.addEventListener('touchend', (e) => {
                const state = store.getState();
                
                // 处理双指缩放结束
                if (state.isPinching) {
                    store.setState({ isPinching: false }); // 结束缩放模式

                    // 标记为曾经有多点触摸，防止误触发关闭
                    store.setState({ wasTouchingWithMultipleFingers: true });
                    
                    // 获取当前图片
                    const activeImg = slidesContainer.querySelector(`.img-preview-slide[data-index="${state.currentImageIndex}"] .img-preview-img`);
                    if (!activeImg) {
                        return;
                    }
                    
                    // 清理动画帧和硬件加速
                    if (this.zoom.animationFrameId) {
                        cancelAnimationFrame(this.zoom.animationFrameId);
                        this.zoom.animationFrameId = null;
                    }
                    this.zoom.pendingTransform = null;
                    activeImg.style.willChange = 'auto'; // 缩放结束后重置硬件加速
                    
                    // 检查当前实际缩放级别
                    if (state.currentZoomLevel < 1) {
                        // 如果低于100%，添加平滑过渡回弹到100%并居中
                        activeImg.style.transition = 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
                        activeImg.style.transform = '';
                        
                        // 重置缩放信息
                        store.setState({
                            currentZoomLevel: 1,
                            isZoomMode: false,
                            zoomCurrentTranslateX: 0,
                            zoomCurrentTranslateY: 0
                        });
                        
                        // 移除过渡效果
                        setTimeout(() => {
                            activeImg.style.transition = '';
                        }, 300);
                    } else if (state.currentZoomLevel > 1) {
                        // 大于100%，保持缩放状态
                        store.setState({ isZoomMode: true });
                    } else {
                        // 正好100%，重置所有变换
                        activeImg.style.transform = '';
                        store.setState({ 
                            isZoomMode: false,
                            zoomCurrentTranslateX: 0,
                            zoomCurrentTranslateY: 0
                        });
                    }

                    if (e.touches.length === 1) { // 从 Pinch 变为单指
                        if (state.isZoomMode) { // 仍然处于放大模式，需要平滑过渡到单指拖拽
                            store.setState({ isDragging: true }); // 允许拖拽
                            this.zoom.zoomDragging = true; // 进入放大拖拽模式 关键：重置拖拽起始点为当前剩余手指的位置
                            this.zoom.zoomStartX = e.touches[0].clientX;
                            this.zoom.zoomStartY = e.touches[0].clientY;
                            // 可选：如果需要，也可以重置非缩放模式的拖拽起始点
                            this.drag.startX = this.zoom.zoomStartX;
                            this.drag.startY = this.zoom.zoomStartY;
                        } else {// 如果缩放刚好在手指抬起时结束 (newZoom <= 1) 则不进入拖拽模式，但仍标记为多点触摸过
                            store.setState({ isDragging: false });
                            this.zoom.zoomDragging = false;
                        }
                    } else if (e.touches.length === 0) { // 两指都已抬起 Pinch 完全结束
                        store.setState({ isDragging: false });
                        this.zoom.zoomDragging = false;
                        if (state.isZoomMode) {// 根据是否仍在缩放状态设置光标
                            modalContent.style.cursor = 'grab';
                        } else {
                            modalContent.style.cursor = '';
                        }
                    }
                } else if (this.zoom.zoomDragging && state.isZoomMode) { // 处理放大模式下的触摸拖拽结束
                    this.zoom.zoomDragging = false;
                    if (Math.abs(this.inertia.velocityX) > CONFIG.INERTIA.MIN_VELOCITY || 
                        Math.abs(this.inertia.velocityY) > CONFIG.INERTIA.MIN_VELOCITY) {
                        InertiaHandler.startInertiaAnimation(); // 启动惯性动画
                    }
                }
                
                if (e.touches.length === 0) { // 如果所有手指都离开屏幕，重置多点触摸标志
                    setTimeout(() => {
                        store.setState({ wasTouchingWithMultipleFingers: false });
                    }, 300); // 给一点延迟，避免触发意外的操作
                }
            });
            
            slidesContainer.addEventListener('touchcancel', (e) => { // 处理触摸取消事件
                store.setState({ 
                    isPinching: false,
                    isDragging: false 
                });
                
                this.zoom.zoomDragging = false;
                
                if (e.touches.length === 0) { // 如果所有手指都离开屏幕，重置多点触摸标志
                    store.setState({ wasTouchingWithMultipleFingers: false });
                }
            });
        },

        // 绑定键盘事件
        bindKeyboardEvents() { // 按ESC键关闭模态框
            document.addEventListener('keydown', (e) => {
                const modal = DOM.modal;
                if (e.key === 'Escape' && modal.classList.contains('active')) {
                    this.closeModal();
                } else if (e.key === 'ArrowLeft' && modal.classList.contains('active')) { // 左箭头键显示上一张图片
                    const state = store.getState();
                    if (state.currentImageIndex > 0) {
                        this.showImage(state.currentImageIndex - 1);
                    }
                } else if (e.key === 'ArrowRight' && modal.classList.contains('active')) { // 右箭头键显示下一张图片
                    const state = store.getState();
                    if (state.currentImageIndex < DOM.images.length - 1) {
                        this.showImage(state.currentImageIndex + 1);
                    }
                }
            });
        },

        // 绑定窗口大小变化事件
        bindResizeEvents() { // 监听窗口大小变化，保持当前图片居中
            window.addEventListener('resize', () => {
                const state = store.getState();
                if (DOM.modal.classList.contains('active')) { // 使用parseFloat确保获取精确的浮点数值
                    const slideWidth = parseFloat(DOM.modalContent.getBoundingClientRect().width);
                    DOM.slidesContainer.style.transition = 'none';
                    // 使用精确浮点数计算，避免四舍五入和取整导致的误差
                    DOM.slidesContainer.style.transform = `translateX(${-state.currentImageIndex * (slideWidth + CONFIG.THUMBNAILS.MARGIN)}px)`;
                    
                    // 获取当前图片元素
                    const activeImg = DOM.slidesContainer.querySelector(`.img-preview-slide[data-index="${state.currentImageIndex}"] .img-preview-img`);
                    if (!activeImg) return;
                    
                    // 暂存当前缩放状态
                    const wasZoomMode = state.isZoomMode;
                    const oldZoomLevel = state.currentZoomLevel;
                    const oldTranslateX = state.zoomCurrentTranslateX;
                    const oldTranslateY = state.zoomCurrentTranslateY;
                    
                    if (state.isZoomMode) { // 如果在缩放模式，计算相对位置的平移值
                        const rect = activeImg.getBoundingClientRect();
                        
                        // 计算调整后的平移值，尽量保持相对于窗口的相对位置
                        const relativeTranslateX = oldTranslateX / rect.width;
                        const relativeTranslateY = oldTranslateY / rect.height;
                        
                        // 应用缩放但更新平移值
                        const newTranslateX = relativeTranslateX * rect.width;
                        const newTranslateY = relativeTranslateY * rect.height;
                        store.setState({
                            zoomCurrentTranslateX: newTranslateX,
                            zoomCurrentTranslateY: newTranslateY
                        });
                        
                        // 应用变换，保持缩放级别但调整平移
                        activeImg.style.transform = `translate(${newTranslateX}px, ${newTranslateY}px) scale(${oldZoomLevel})`;
                        
                        // 设置抓手样式
                        DOM.modalContent.style.cursor = 'grab';
                    } else {
                        // 如果不在缩放模式，完全重置所有图片样式
                        DOM.slidesContainer.querySelectorAll('.img-preview-img').forEach(img => {
                            img.style.transform = '';
                            img.style.transformOrigin = '';
                        });
                        
                        // 恢复默认鼠标样式
                        DOM.modalContent.style.cursor = '';
                    }
                    
                    // 恢复过渡效果
                    setTimeout(() => {
                        DOM.slidesContainer.style.transition = '';
                    }, 50);
                }
            });
        },

        // 绑定图片点击事件 (用于打开预览)
        bindImageClickEvents() {
            DOM.images.forEach((img, index) => {
                // 跟踪触摸/点击起始位置和是否发生拖动
                let startPosX = 0;
                let startPosY = 0;
                let isDraggingImg = false;
                
                // 添加鼠标按下事件
                img.addEventListener('mousedown', (e) => {
                    startPosX = e.clientX;
                    startPosY = e.clientY;
                    isDraggingImg = false;
                });
                
                // 添加鼠标移动事件
                img.addEventListener('mousemove', (e) => {
                    // 如果移动距离超过5px，视为拖拽
                    if (Math.abs(e.clientX - startPosX) > CONFIG.DRAG.THRESHOLD || 
                        Math.abs(e.clientY - startPosY) > CONFIG.DRAG.THRESHOLD) {
                        isDraggingImg = true;
                    }
                });
                
                // 鼠标点击事件
                img.addEventListener('click', (e) => {
                    if (!isDraggingImg) {
                        this.showImage(index);
                    }
                });
                
                // 触摸开始事件
                img.addEventListener('touchstart', (e) => {
                    if (e.touches.length === 1) {
                        startPosX = e.touches[0].clientX;
                        startPosY = e.touches[0].clientY;
                        isDraggingImg = false;
                    }
                });
                
                // 触摸移动事件
                img.addEventListener('touchmove', (e) => {
                    // 如果移动距离超过5px，视为拖拽
                    if (e.touches.length === 1 && 
                        (Math.abs(e.touches[0].clientX - startPosX) > CONFIG.DRAG.THRESHOLD || 
                         Math.abs(e.touches[0].clientY - startPosY) > CONFIG.DRAG.THRESHOLD)) {
                        isDraggingImg = true;
                    }
                });
                
                // 触摸结束事件
                img.addEventListener('touchend', (e) => {
                    if (!isDraggingImg) {
                        e.preventDefault();
                        this.showImage(index);
                    }
                });
                
                // 禁用默认拖拽行为
                img.draggable = false;
            });
        },

        // 显示指定索引的图片
        showImage(index) {
            if (index < 0 || index >= DOM.images.length) return;
            const oldIndex = store.getState().currentImageIndex;
            store.setState({ currentImageIndex: index });
            
            // 先激活模态框再获取宽度
            DOM.modal.classList.add('active');
            
            // 决定是否应用过渡
            const state = store.getState();
            const applyTransition = !state.isInitialLoad;
            
            // 异步获取准确宽度并应用变换
            requestAnimationFrame(() => {
                // 使用getBoundingClientRect获取精确的浮点数宽度，避免整数舍入
                const slideWidth = parseFloat(DOM.modalContent.getBoundingClientRect().width);

                if (applyTransition) {
                    // 后续切换：应用过渡
                    DOM.slidesContainer.style.transition = `transform ${CONFIG.ANIMATION.DURATION}ms ${CONFIG.ANIMATION.TIMING}`;
                } else {
                    // 首次加载：禁用过渡，并更新标志
                    DOM.slidesContainer.style.transition = 'none';
                    store.setState({ isInitialLoad: false });
                }

                // 计算位移时考虑每个slide的右侧间距，使用精确浮点数计算
                const exactOffset = -index * (slideWidth + CONFIG.THUMBNAILS.MARGIN);
                DOM.slidesContainer.style.transform = `translateX(${exactOffset}px)`;

                if (applyTransition) {
                    // 动画结束后移除过渡，避免干扰拖动
                    setTimeout(() => {
                        DOM.slidesContainer.style.transition = '';
                    }, CONFIG.ANIMATION.DURATION);
                }
            });
            
            // 重置状态
            store.setState({
                isZoomMode: false,
                currentZoomLevel: 1,
                zoomCurrentTranslateX: 0,
                zoomCurrentTranslateY: 0
            });
            
            // 重置垂直位移和缩放
            DOM.slidesContainer.style.transformOrigin = 'center';
            DOM.slidesContainer.classList.remove('vertical-dragging');
            
            // 重置所有图片的垂直位置和缩放
            DOM.slidesContainer.querySelectorAll('.img-preview-img').forEach(img => {
                img.style.transform = '';
                img.style.transformOrigin = '';
            });
            
            // 更新活动状态
            const slides = DOM.slidesContainer.querySelectorAll('.img-preview-slide');
            slides.forEach((slide, i) => {
                slide.classList.toggle('active', i === index);
            });
            
            // 更新标题栏内容
            const activeSlide = slides[index];
            const captionText = activeSlide.dataset.caption;
            
            if (captionText && captionText.trim() !== '') {
                DOM.captionContainer.textContent = captionText;
                DOM.captionContainer.style.display = 'block';
            } else {
                DOM.captionContainer.style.display = 'none';
            }
            
            document.body.style.overflow = 'hidden'; // 禁用背景页面滚动
            
            // 更新缩略图状态和宽高比
            const thumbnails = DOM.thumbnails;
            thumbnails.forEach((thumb, i) => {
                thumb.classList.toggle('active', i === index);
                
                // 确保获取到宽高比信息（可能是同步或异步获取）
                const aspectRatioData = Utils.getImageAspectRatio(DOM.images[i], this.imageAspectRatios, DOM.images);
                
                // 如果aspectRatioData还未就绪 (图片还在加载中)，Utils.getImageAspectRatio内部会处理
                // 这里我们直接使用缓存或已计算好的结果
                if (aspectRatioData) {
                    // 设置正确的aspect-ratio
                    if (i === index) {
                        // 激活状态的缩略图使用原图的宽高比
                        thumb.style.aspectRatio = aspectRatioData.original || CONFIG.ASPECT_RATIO_PRESETS.landscape; // Fallback
                    } else {
                        // 非激活状态的缩略图使用预设比例
                        thumb.style.aspectRatio = aspectRatioData.preset;
                    }
                } else {
                     // 如果宽高比数据还不可用（理论上不应发生，因为Utils.getImageAspectRatio会处理加载）
                     // 可以设置一个默认值或等待
                     thumb.style.aspectRatio = CONFIG.ASPECT_RATIO_PRESETS.landscape; // Fallback
                }
            });
            
            // 滚动缩略图到当前图片位置
            const activeThumb = thumbnails[index];
            const containerWidth = DOM.thumbnailsContainer.offsetWidth;
            const thumbWidth = activeThumb.offsetWidth;
            const thumbLeft = activeThumb.offsetLeft;
            const scrollLeft = thumbLeft - (containerWidth / 2) + (thumbWidth / 2);
            
            // 添加平滑滚动效果
            DOM.thumbnailsContainer.classList.add('img-preview-smooth-scroll');
            DOM.thumbnailsContainer.scrollLeft = scrollLeft;
            
            // 滚动完成后移除平滑效果，以便拖动时保持即时响应
            setTimeout(() => {
                DOM.thumbnailsContainer.classList.remove('img-preview-smooth-scroll');
                DOM.thumbnailsContainer.classList.add('img-preview-auto-scroll');
            }, 500);

            // 同步背景网页位置
            const currentImg = DOM.images[index];
            
            // 移除之前可能的动画类和样式类
            DOM.images.forEach(img => {
                img.classList.remove('img-preview-zoom-animation');
                img.classList.remove('img-preview-zoom-initial');
                img.classList.remove('img-preview-zoom-reset');
            });
            
            // 预先设置背景图片的2倍缩放
            currentImg.classList.add('img-preview-zoom-initial');
            
            if (currentImg.closest('.image-carousel')) {
                // 如果是轮播图，滚动到顶部并切换到对应图片
                window.scrollTo(0, 0);
                const carousel = currentImg.closest('.image-carousel');
                const carouselImgs = Array.from(carousel.querySelectorAll('.carousel-item img'));
                const carouselIndex = carouselImgs.indexOf(currentImg);
                if (carouselIndex !== -1 && carousel._carouselInstance) {
                    // 使用实例方法更新轮播图状态
                    carousel._carouselInstance.currentIndex = carouselIndex;
                    carousel._carouselInstance.updateCarousel();
                }
            } else if (currentImg.closest('.Content-Type')) {
                // 如果是普通图片，滚动到图片位置，使图片位于视口中间
                const imgRect = currentImg.getBoundingClientRect();
                const windowHeight = window.innerHeight;
                const scrollTop = window.scrollY + imgRect.top - (windowHeight / 2) + (imgRect.height / 2);
                window.scrollTo(0, scrollTop);
            }
        },

        // 关闭模态框
        closeModal() {
            const state = store.getState();
            const currentImg = DOM.images[state.currentImageIndex];
            
            // 添加缩放动画类
            if (currentImg) {
                // 确保背景图片已经设置了初始缩放
                if (!currentImg.classList.contains('img-preview-zoom-initial')) {
                    currentImg.classList.add('img-preview-zoom-initial');
                }
                
                // 添加CSS动画类
                currentImg.classList.add('img-preview-zoom-animation');
                
                // 动画结束后清理样式
                currentImg.addEventListener('animationend', function onAnimEnd() {
                    currentImg.classList.remove('img-preview-zoom-initial');
                    currentImg.classList.remove('img-preview-zoom-animation');
                    currentImg.classList.add('img-preview-zoom-reset');
                    
                    // 延迟一小段时间后移除重置类，确保样式已应用
                    setTimeout(() => {
                        currentImg.classList.remove('img-preview-zoom-reset');
                    }, 100);
                    
                    currentImg.removeEventListener('animationend', onAnimEnd);
                }, { once: true });
            }
            
            DOM.modal.classList.remove('active');
            document.body.style.overflow = ''; // 恢复背景页面滚动
            
            // 重置模态框样式
            setTimeout(() => {
                DOM.slidesContainer.style.transform = '';
                DOM.slidesContainer.classList.remove('vertical-dragging');
                DOM.thumbnailsContainer.classList.remove('img-preview-hidden');
                // 恢复标题栏显示
                DOM.captionContainer.classList.remove('img-preview-hidden');
                DOM.modal.style.backgroundColor = '';
                
                // 重置状态
                store.setState({
                    isInitialLoad: true,
                    currentZoomLevel: 1,
                    isZoomMode: false,
                    zoomCurrentTranslateX: 0,
                    zoomCurrentTranslateY: 0,
                    isDragging: false,
                    isVerticalDragging: false
                });
                
                // 重置鼠标样式
                DOM.modalContent.style.cursor = '';
            }, CONFIG.ANIMATION.DURATION);
        }
    };

    // 拖拽操作模块
    const DragHandler = {
        // 处理拖动结束
        handleDragEnd(verticalDistance, isVerticalDragging) {
            const state = store.getState();
            const modal = DOM.modal;
            const slidesContainer = DOM.slidesContainer;
            const activeImg = slidesContainer.querySelector(`.img-preview-slide[data-index="${state.currentImageIndex}"] .img-preview-img`);
            // 先更新状态，停止拖拽
            store.setState({ 
                isDragging: false, 
                isVerticalDragging: false 
            });
            if (isVerticalDragging) {
                // 垂直拖动结束
                slidesContainer.classList.remove('vertical-dragging');
                // 向下拖动且距离超过关闭阈值，则关闭模态框
                if (verticalDistance > CONFIG.DRAG.CLOSE_THRESHOLD) {
                    ImagePreview.closeModal();
                } else {
                    // 距离不够，复位图片
                    if (activeImg) {
                        activeImg.style.transition = `transform ${CONFIG.ANIMATION.DURATION}ms ${CONFIG.ANIMATION.TIMING}`;
                        activeImg.style.transform = '';
                        // 恢复模态框样式
                        modal.style.backgroundColor = `rgba(${CONFIG.DRAG_EFFECTS.BACKGROUND_RGB}, 1)`;
                        const baseBlurStyle = `blur(${CONFIG.DRAG_EFFECTS.BACKDROP_BLUR_BASE}px)`;
                        modal.style.backdropFilter = baseBlurStyle;
                        modal.style.webkitBackdropFilter = baseBlurStyle;
                        // 移除过渡效果
                        setTimeout(() => {
                            activeImg.style.transition = '';
                        }, CONFIG.ANIMATION.DURATION);
                    }
                    // 恢复缩略图和标题
                    DOM.thumbnailsContainer.classList.remove('img-preview-hidden');
                    DOM.captionContainer.classList.remove('img-preview-hidden');
                }
            } else {
                // 水平拖动结束
                // 使用getBoundingClientRect获取精确的浮点数宽度
                const slideWidth = parseFloat(DOM.modalContent.getBoundingClientRect().width);
                const currentTranslate = Utils.getTranslateX(slidesContainer);
                const targetIndex = state.currentImageIndex;
                // 计算当前滑动位置与目标位置的差距，使用精确浮点数计算
                const targetOffset = -targetIndex * (slideWidth + CONFIG.THUMBNAILS.MARGIN);
                const diffX = currentTranslate - targetOffset;
                if (Math.abs(diffX) > CONFIG.DRAG.HORIZONTAL_SWIPE_THRESHOLD) {
                    // 如果拖动超过阈值，则切换图片
                    let newIndex = targetIndex;
                    if (diffX > 0) {
                        // 向右拖动，显示上一张
                        newIndex = Math.max(0, targetIndex - 1);
                    } else {
                        // 向左拖动，显示下一张
                        newIndex = Math.min(DOM.images.length - 1, targetIndex + 1);
                    }
                    if (newIndex !== targetIndex) {
                        ImagePreview.showImage(newIndex);
                    } else {
                        // 如果到达边界，复位当前图片
                        slidesContainer.style.transition = `transform ${CONFIG.ANIMATION.DURATION}ms ${CONFIG.ANIMATION.TIMING}`;
                        slidesContainer.style.transform = `translateX(${-targetIndex * (slideWidth + CONFIG.THUMBNAILS.MARGIN)}px)`;
                        // 移除过渡效果
                        setTimeout(() => {
                            slidesContainer.style.transition = '';
                        }, CONFIG.ANIMATION.DURATION);
                    }
                } else {
                    // 拖动距离不够，复位当前图片
                    slidesContainer.style.transition = `transform ${CONFIG.ANIMATION.DURATION}ms ${CONFIG.ANIMATION.TIMING}`;
                    slidesContainer.style.transform = `translateX(${targetOffset}px)`;
                    // 移除过渡效果
                    setTimeout(() => {
                        slidesContainer.style.transition = '';
                    }, CONFIG.ANIMATION.DURATION);
                }
            }
        }
    };

    // 缩放操作模块
    const ZoomHandler = {
        // 处理滚轮缩放
        handleWheelZoom(e) {
            const state = store.getState();
            const modal = DOM.modal;
            const slidesContainer = DOM.slidesContainer;
            const modalContent = DOM.modalContent;
            if (!modal.classList.contains('active')) return;
            e.preventDefault(); // 阻止页面滚动
            const activeImg = slidesContainer.querySelector(`.img-preview-slide[data-index="${state.currentImageIndex}"] .img-preview-img`);
            if (!activeImg) return;
            // 获取图片原始尺寸和当前渲染尺寸
            const rect = activeImg.getBoundingClientRect();
            // 计算缩放前图片的实际渲染尺寸（移除当前缩放影响）
            const preScaledWidth = rect.width / state.currentZoomLevel;
            const preScaledHeight = rect.height / state.currentZoomLevel;
            // 获取鼠标在屏幕上的绝对位置
            const mouseX = e.clientX;
            const mouseY = e.clientY;
            // 计算鼠标相对于图片中心的位置
            const imgCenterX = rect.left + rect.width / 2;
            const imgCenterY = rect.top + rect.height / 2;
            // 计算鼠标相对于图片中心的向量
            const vectorX = mouseX - imgCenterX;
            const vectorY = mouseY - imgCenterY;
            // 计算这个向量相对于图片宽高的比例
            const relativeX = vectorX / (rect.width / 2);
            const relativeY = vectorY / (rect.height / 2);
            const delta = -e.deltaY; // 获取滚轮方向和幅度
            const zoomFactor = delta > 0 ? CONFIG.ZOOM.STEP : CONFIG.ZOOM.STEP; // 缩放因子
            // 计算新的缩放级别，允许临时缩放低于100%
            let newZoom = state.currentZoomLevel + (delta > 0 ? zoomFactor : -zoomFactor);
            // 限制缩放范围
            newZoom = Math.max(CONFIG.ZOOM.MIN, Math.min(newZoom, CONFIG.ZOOM.MAX));
            // 如果缩放级别没有变化，则不执行后续操作
            if (newZoom === state.currentZoomLevel) return;
            // 计算缩放前后的图片物理尺寸变化
            const newScaledWidth = preScaledWidth * newZoom;
            const newScaledHeight = preScaledHeight * newZoom;
            const deltaWidth = newScaledWidth - rect.width;
            const deltaHeight = newScaledHeight - rect.height;
            // 计算缩放补偿
            const scaleCompensationX = -deltaWidth * relativeX * 0.5;
            const scaleCompensationY = -deltaHeight * relativeY * 0.5;
            // 计算最终位置
            let newTranslateX = state.zoomCurrentTranslateX + scaleCompensationX;
            let newTranslateY = state.zoomCurrentTranslateY + scaleCompensationY;
            // 获取可移动边界信息
            const boundaries = Utils.calculateImageBoundaries(activeImg, newZoom, state.currentZoomLevel, modalContent);
            // 智能边界限制
            if (newZoom > 1) {
                // 只有当允许水平移动时才限制X轴
                if (boundaries.allowHorizontal) {
                    newTranslateX = Math.max(-boundaries.bounds.x, Math.min(boundaries.bounds.x, newTranslateX));
                } else {
                    // 不允许水平移动时强制居中
                    newTranslateX = 0;
                }
                // 只有当允许垂直移动时才限制Y轴
                if (boundaries.allowVertical) {
                    newTranslateY = Math.max(-boundaries.bounds.y, Math.min(boundaries.bounds.y, newTranslateY));
                } else {
                    // 不允许垂直移动时强制居中
                    newTranslateY = 0;
                }
            }
            // 更新状态
            store.setState({ 
                currentZoomLevel: newZoom,
                zoomCurrentTranslateX: newTranslateX,
                zoomCurrentTranslateY: newTranslateY
            });
            // 应用变换，添加过渡效果使缩放更平滑
            activeImg.style.transition = 'transform 0.3s ease';
            if (newZoom < 1) {
                // 如果缩放小于100%，应用缩放但不更新isZoomMode状态
                activeImg.style.transform = `translate(${newTranslateX}px, ${newTranslateY}px) scale(${newZoom})`;
                // 设置一个定时器，在缩放停止后检查是否需要弹回
                clearTimeout(activeImg._zoomTimer);
                activeImg._zoomTimer = setTimeout(() => {
                    // 如果仍处于低于100%的缩放状态，则弹回
                    const currentState = store.getState();
                    if (currentState.currentZoomLevel < 1) {
                        activeImg.style.transition = 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
                        activeImg.style.transform = '';
                        // 重置缩放信息
                        store.setState({
                            currentZoomLevel: 1,
                            isZoomMode: false,
                            zoomCurrentTranslateX: 0,
                            zoomCurrentTranslateY: 0
                        });
                        // 恢复默认鼠标样式
                        modalContent.style.cursor = '';
                        // 移除过渡效果
                        setTimeout(() => {
                            activeImg.style.transition = '';
                        }, 300);
                    }
                }, 300);  // 300ms无滚轮操作后触发弹回
            } else if (newZoom > 1) {
                // 如果缩放大于100%，则进入缩放模式
                store.setState({ isZoomMode: true });
                activeImg.style.transform = `translate(${newTranslateX}px, ${newTranslateY}px) scale(${newZoom})`;
                // 进入放大模式，设置鼠标样式为抓手
                modalContent.style.cursor = 'grab';
            } else {
                // 缩放恰好等于100%，重置所有变换
                activeImg.style.transform = '';
                store.setState({
                    isZoomMode: false,
                    zoomCurrentTranslateX: 0,
                    zoomCurrentTranslateY: 0
                });
                // 恢复默认鼠标样式
                modalContent.style.cursor = '';
            }
            // 移除过渡效果，避免干扰后续操作
            setTimeout(() => {
                if (store.getState().currentZoomLevel >= 1) {  // 只在不需要弹回动画时清除过渡
                    activeImg.style.transition = '';
                }
            }, 100);
        },
        // 处理缩放状态拖拽
        handleZoomDrag(e, isTouch) {
            const state = store.getState();
            const slidesContainer = DOM.slidesContainer;
            const modalContent = DOM.modalContent;
            if (!state.isZoomMode) return;
            e.preventDefault();
            const pos = isTouch ? e.touches[0] : e;
            const diffX = pos.clientX - ImagePreview.zoom.zoomStartX;
            const diffY = pos.clientY - ImagePreview.zoom.zoomStartY;
            // 获取当前显示的图片
            const activeImg = slidesContainer.querySelector(`.img-preview-slide[data-index="${state.currentImageIndex}"] .img-preview-img`);
            if (!activeImg) return;
            // 获取可移动边界信息
            const boundaries = Utils.calculateImageBoundaries(activeImg, state.currentZoomLevel, state.currentZoomLevel, modalContent);
            // 新的平移位置
            let newTranslateX = state.zoomCurrentTranslateX + diffX;
            let newTranslateY = state.zoomCurrentTranslateY + diffY;
            // 智能边界限制
            if (boundaries.allowHorizontal) {
                newTranslateX = Math.max(-boundaries.bounds.x, Math.min(boundaries.bounds.x, newTranslateX));
            } else {
                newTranslateX = 0;  // 如果图片宽度小于容器，强制水平居中
            }
            if (boundaries.allowVertical) {
                newTranslateY = Math.max(-boundaries.bounds.y, Math.min(boundaries.bounds.y, newTranslateY));
            } else {
                newTranslateY = 0;  // 如果图片高度小于容器，强制垂直居中
            }
            // 应用平移
            activeImg.style.transform = `translate(${newTranslateX}px, ${newTranslateY}px) scale(${state.currentZoomLevel})`;
            // 更新状态
            store.setState({
                zoomCurrentTranslateX: newTranslateX,
                zoomCurrentTranslateY: newTranslateY
            });
            // 更新惯性追踪变量
            const currentTime = performance.now();
            const deltaTime = currentTime - ImagePreview.inertia.lastMoveTime;
            // 计算速度
            if (deltaTime > 0) {
                ImagePreview.inertia.velocityX = (pos.clientX - ImagePreview.inertia.lastPosX) / deltaTime;
                ImagePreview.inertia.velocityY = (pos.clientY - ImagePreview.inertia.lastPosY) / deltaTime;
            }
            ImagePreview.inertia.lastPosX = pos.clientX;
            ImagePreview.inertia.lastPosY = pos.clientY;
            ImagePreview.inertia.lastMoveTime = currentTime;
            // 更新起始位置以进行下一次移动计算
            ImagePreview.zoom.zoomStartX = pos.clientX;
            ImagePreview.zoom.zoomStartY = pos.clientY;
        },
        // 处理双指缩放
        handlePinchZoom(e, touch1, touch2, zoomData) {
            const state = store.getState();
            const slidesContainer = DOM.slidesContainer;
            const modalContent = DOM.modalContent;
            
            // 获取当前双指距离
            const currentDistance = Math.hypot(
                touch2.clientX - touch1.clientX,
                touch2.clientY - touch1.clientY
            );

            // 计算缩放比例变化
            const pinchRatio = currentDistance / zoomData.initialPinchDistance;
            
            // 平滑处理缩放比例
            const smoothedPinchRatio = zoomData.lastPinchRatio + 
                (pinchRatio - zoomData.lastPinchRatio) * zoomData.smoothingFactor;
            
            // 如果变化太小，保持上次的比例
            const isPinchChangeSufficient = Math.abs(smoothedPinchRatio - zoomData.lastPinchRatio) >= 
                CONFIG.PINCH.MIN_CHANGE;
            const effectivePinchRatio = isPinchChangeSufficient ? 
                smoothedPinchRatio : zoomData.lastPinchRatio;
            
            // 更新上次缩放比例
            zoomData.lastPinchRatio = isPinchChangeSufficient ? 
                smoothedPinchRatio : zoomData.lastPinchRatio;
            
            // 新的缩放级别 = 开始缩放时的级别 * 手指距离比例
            let newZoom = zoomData.pinchStartZoom * effectivePinchRatio;
            newZoom = Math.max(CONFIG.ZOOM.MIN, Math.min(newZoom, CONFIG.ZOOM.MAX));
            
            // 获取当前图片元素
            const activeImg = slidesContainer.querySelector(
                `.img-preview-slide[data-index="${state.currentImageIndex}"] .img-preview-img`
            );
            if (!activeImg) return;
            
            // 原始双指中点计算
            const rawTouchMidpoint = {
                x: (touch1.clientX + touch2.clientX) / 2,
                y: (touch1.clientY + touch2.clientY) / 2
            };
            
            // 平滑处理触摸中点
            const currentTouchMidpoint = {
                x: zoomData.lastTouchMidpoint.x + 
                    (rawTouchMidpoint.x - zoomData.lastTouchMidpoint.x) * zoomData.smoothingFactor,
                y: zoomData.lastTouchMidpoint.y + 
                    (rawTouchMidpoint.y - zoomData.lastTouchMidpoint.y) * zoomData.smoothingFactor
            };
            
            // 更新上次触摸中点
            zoomData.lastTouchMidpoint = { ...currentTouchMidpoint };
            
            // 获取图片尺寸
            const imageRect = activeImg.getBoundingClientRect();
            
            // 计算手指中点相对于当前图片中心的位置向量
            const imgCenterX = imageRect.left + imageRect.width / 2;
            const imgCenterY = imageRect.top + imageRect.height / 2;
            
            // 计算向量，从图片中心指向触摸中点
            const vectorX = currentTouchMidpoint.x - imgCenterX;
            const vectorY = currentTouchMidpoint.y - imgCenterY;
            
            // 计算这个向量相对于图片宽高的比例
            const relativeX = vectorX / (imageRect.width / 2);
            const relativeY = vectorY / (imageRect.height / 2);
            
            // 计算缩放前后的图片物理尺寸变化
            const preScaledWidth = imageRect.width / state.currentZoomLevel;
            const preScaledHeight = imageRect.height / state.currentZoomLevel;
            const newScaledWidth = preScaledWidth * newZoom;
            const newScaledHeight = preScaledHeight * newZoom;
            const deltaWidth = newScaledWidth - imageRect.width;
            const deltaHeight = newScaledHeight - imageRect.height;
            
            // 考虑手指中点移动
            const midpointDeltaX = currentTouchMidpoint.x - zoomData.initialTouchMidpoint.x;
            const midpointDeltaY = currentTouchMidpoint.y - zoomData.initialTouchMidpoint.y;
            
            // 计算缩放补偿
            const scaleCompensationX = -deltaWidth * relativeX * 0.5;
            const scaleCompensationY = -deltaHeight * relativeY * 0.5;
            
            // 结合手指移动和缩放补偿计算最终位置
            let newTranslateX = zoomData.pinchStartTranslateX + midpointDeltaX + scaleCompensationX;
            let newTranslateY = zoomData.pinchStartTranslateY + midpointDeltaY + scaleCompensationY;
            
            // 获取可移动边界信息
            const boundaries = Utils.calculateImageBoundaries(activeImg, newZoom, state.currentZoomLevel, modalContent);
            
            // 智能边界限制
            if (newZoom > 1) {
                // 只有当允许水平移动时才限制X轴
                if (boundaries.allowHorizontal) {
                    newTranslateX = Math.max(-boundaries.bounds.x, Math.min(boundaries.bounds.x, newTranslateX));
                } else {
                    // 不允许水平移动时强制居中
                    newTranslateX = 0;
                }
                
                // 只有当允许垂直移动时才限制Y轴
                if (boundaries.allowVertical) {
                    newTranslateY = Math.max(-boundaries.bounds.y, Math.min(boundaries.bounds.y, newTranslateY));
                } else {
                    // 不允许垂直移动时强制居中
                    newTranslateY = 0;
                }
            }
            
            // 返回计算结果
            return {
                newZoom,
                newTranslateX,
                newTranslateY,
                needsUpdate: Math.abs(newZoom - state.currentZoomLevel) >= CONFIG.PINCH.MIN_CHANGE ||
                    Math.abs(newTranslateX - state.zoomCurrentTranslateX) >= CONFIG.PINCH.MIN_POSITION_CHANGE ||
                    Math.abs(newTranslateY - state.zoomCurrentTranslateY) >= CONFIG.PINCH.MIN_POSITION_CHANGE
            };
        }
    };

    // 惯性动画模块
    const InertiaHandler = {
        // 启动惯性动画
        startInertiaAnimation() {
            const state = store.getState();
            const slidesContainer = DOM.slidesContainer;
            const modalContent = DOM.modalContent;
            
            // 获取当前图片元素
            const activeImg = slidesContainer.querySelector(`.img-preview-slide[data-index="${state.currentImageIndex}"] .img-preview-img`);
            if (!activeImg || !state.isZoomMode) {
                // 重置速度
                ImagePreview.inertia.velocityX = 0;
                ImagePreview.inertia.velocityY = 0;
                
                // 取消已经存在的动画
                if (ImagePreview.inertia.inertiaFrameId) {
                    cancelAnimationFrame(ImagePreview.inertia.inertiaFrameId);
                    ImagePreview.inertia.inertiaFrameId = null;
                }
                return;
            }
            
            // 停止之前的动画（如果有）
            if (ImagePreview.inertia.inertiaFrameId) {
                cancelAnimationFrame(ImagePreview.inertia.inertiaFrameId);
            }
            
            let lastTime = performance.now();
            
            function inertiaStep(currentTime) {
                const deltaTime = currentTime - lastTime;
                lastTime = currentTime;
                
                // 计算当前帧的位移
                const deltaX = ImagePreview.inertia.velocityX * deltaTime;
                const deltaY = ImagePreview.inertia.velocityY * deltaTime;
                
                // 获取当前状态
                const currentState = store.getState();
                
                // 计算新的目标位置
                let newTranslateX = currentState.zoomCurrentTranslateX + deltaX;
                let newTranslateY = currentState.zoomCurrentTranslateY + deltaY;
                
                // 获取边界
                const boundaries = Utils.calculateImageBoundaries(
                    activeImg, 
                    currentState.currentZoomLevel, 
                    currentState.currentZoomLevel, 
                    modalContent
                );
                
                // 应用边界限制
                let stoppedX = false, stoppedY = false;
                
                if (boundaries.allowHorizontal) {
                    if (newTranslateX < -boundaries.bounds.x) {
                        newTranslateX = -boundaries.bounds.x;
                        ImagePreview.inertia.velocityX = 0; // 碰到边界停止X方向惯性
                        stoppedX = true;
                    } else if (newTranslateX > boundaries.bounds.x) {
                        newTranslateX = boundaries.bounds.x;
                        ImagePreview.inertia.velocityX = 0;
                        stoppedX = true;
                    }
                } else {
                    newTranslateX = 0;
                    ImagePreview.inertia.velocityX = 0;
                    stoppedX = true;
                }
                
                if (boundaries.allowVertical) {
                    if (newTranslateY < -boundaries.bounds.y) {
                        newTranslateY = -boundaries.bounds.y;
                        ImagePreview.inertia.velocityY = 0; // 碰到边界停止Y方向惯性
                        stoppedY = true;
                    } else if (newTranslateY > boundaries.bounds.y) {
                        newTranslateY = boundaries.bounds.y;
                        ImagePreview.inertia.velocityY = 0;
                        stoppedY = true;
                    }
                } else {
                    newTranslateY = 0;
                    ImagePreview.inertia.velocityY = 0;
                    stoppedY = true;
                }
                
                // 更新状态
                store.setState({
                    zoomCurrentTranslateX: newTranslateX,
                    zoomCurrentTranslateY: newTranslateY
                });
                
                // 应用变换
                activeImg.style.transform = `translate(${newTranslateX}px, ${newTranslateY}px) scale(${currentState.currentZoomLevel})`;
                
                // 应用阻尼
                ImagePreview.inertia.velocityX *= CONFIG.INERTIA.DAMPING;
                ImagePreview.inertia.velocityY *= CONFIG.INERTIA.DAMPING;
                
                // 检查是否停止动画
                if (Math.abs(ImagePreview.inertia.velocityX) < CONFIG.INERTIA.MIN_VELOCITY && 
                    Math.abs(ImagePreview.inertia.velocityY) < CONFIG.INERTIA.MIN_VELOCITY) {
                    // 取消动画
                    cancelAnimationFrame(ImagePreview.inertia.inertiaFrameId);
                    ImagePreview.inertia.inertiaFrameId = null;
                    
                    // 确保光标恢复
                    if (currentState.isZoomMode) {
                        modalContent.style.cursor = 'grab';
                    }
                } else {
                    // 继续下一帧
                    ImagePreview.inertia.inertiaFrameId = requestAnimationFrame(inertiaStep);
                }
            }
            
            // 开始第一帧
            ImagePreview.inertia.inertiaFrameId = requestAnimationFrame(inertiaStep);
        }
    };

    // 双击缩放操作模块
    const DoubleClickZoomHandler = {
        lastTapTime: 0,
        tapTimeout: null,
        TAP_DELAY: 300, // ms - 判定双击的延迟
        // 添加拖拽检测变量
        startPosX: 0,
        startPosY: 0,
        hasMoved: false,

        init() {
            this.bindDoubleClickEvents();
        },

        bindDoubleClickEvents() {
            const slidesContainer = DOM.slidesContainer;
            
            // 监听下按事件，用于记录起始位置
            slidesContainer.addEventListener('mousedown', (e) => {
                if (!e.target.classList.contains('img-preview-img')) return;
                this.startPosX = e.clientX;
                this.startPosY = e.clientY;
                this.hasMoved = false;
            });
            
            slidesContainer.addEventListener('touchstart', (e) => {
                if (!e.target.classList.contains('img-preview-img')) return;
                if (e.touches.length === 1) {
                    this.startPosX = e.touches[0].clientX;
                    this.startPosY = e.touches[0].clientY;
                    this.hasMoved = false;
                }
            }, { passive: true });
            
            // 监听移动事件，判断是否有拖拽
            slidesContainer.addEventListener('mousemove', (e) => {
                if (!e.target.classList.contains('img-preview-img')) return;
                if (Math.abs(e.clientX - this.startPosX) > CONFIG.DRAG.THRESHOLD || 
                    Math.abs(e.clientY - this.startPosY) > CONFIG.DRAG.THRESHOLD) {
                    this.hasMoved = true;
                }
            });
            
            slidesContainer.addEventListener('touchmove', (e) => {
                if (!e.target.classList.contains('img-preview-img')) return;
                if (e.touches.length === 1) {
                    if (Math.abs(e.touches[0].clientX - this.startPosX) > CONFIG.DRAG.THRESHOLD || 
                        Math.abs(e.touches[0].clientY - this.startPosY) > CONFIG.DRAG.THRESHOLD) {
                        this.hasMoved = true;
                    }
                }
            }, { passive: true });
            
            // 原有的点击和触摸结束事件
            slidesContainer.addEventListener('click', this.handleClick.bind(this));
            slidesContainer.addEventListener('touchend', this.handleTouchEnd.bind(this), { passive: false }); 
        },

        handleClick(e) {
            // 仅当目标是图片本身时触发
            if (!e.target.classList.contains('img-preview-img')) return;
            e.preventDefault(); // 阻止可能的默认行为（如图片链接）
            
            // 如果检测到拖拽，不触发双击
            if (this.hasMoved) {
                this.hasMoved = false; // 重置拖拽状态
                return;
            }
            
            const currentTime = new Date().getTime();
            const timeSinceLastTap = currentTime - this.lastTapTime;
            clearTimeout(this.tapTimeout); // 清除可能存在的单击计时器
            
            if (timeSinceLastTap < this.TAP_DELAY && timeSinceLastTap > 0) {
                // 检测到双击
                this.handleDoubleClick(e);
                this.lastTapTime = 0; // 重置时间，避免连续触发
            } else {
                // 可能是单击，设置计时器等待看是否有第二次点击
                this.tapTimeout = setTimeout(() => {
                    // 单击超时，可以在这里执行单击逻辑（如果需要）
                }, this.TAP_DELAY);
                this.lastTapTime = currentTime;
            }
        },

        handleTouchEnd(e) {
            // 仅当目标是图片本身时触发
            if (!e.target.classList.contains('img-preview-img')) return;
            // 如果还有其他手指在屏幕上，则不处理双击
            if (e.touches.length > 0) return;
            // 阻止 touchend 后触发 click 事件，避免重复处理
            e.preventDefault();
            
            // 如果检测到拖拽，不触发双击
            if (this.hasMoved) {
                this.hasMoved = false; // 重置拖拽状态
                return;
            }
            
            const currentTime = new Date().getTime();
            const timeSinceLastTap = currentTime - this.lastTapTime;
            clearTimeout(this.tapTimeout); // 清除单击计时器
            
            if (timeSinceLastTap < this.TAP_DELAY && timeSinceLastTap > 0) {
                // 检测到双击 (Double Tap)
                this.handleDoubleClick(e);
                this.lastTapTime = 0; // 重置时间
            } else {
                // 可能是单击 (Single Tap)
                this.tapTimeout = setTimeout(() => {
                    // 单击超时逻辑（如果需要）注意：关闭模态框的单击逻辑在 modalContent 的监听器中
                }, this.TAP_DELAY);
                this.lastTapTime = currentTime;
            }
        },

        handleDoubleClick(e) {
            const state = store.getState();
            const activeImg = e.target;
            const modalContent = DOM.modalContent;
            if (!activeImg) return;
            // 停止所有正在进行的动画
            if (ImagePreview.inertia.inertiaFrameId) {
                cancelAnimationFrame(ImagePreview.inertia.inertiaFrameId);
                ImagePreview.inertia.inertiaFrameId = null;
                ImagePreview.inertia.velocityX = 0;
                ImagePreview.inertia.velocityY = 0;
            }
            if (ImagePreview.zoom.animationFrameId) {
                cancelAnimationFrame(ImagePreview.zoom.animationFrameId);
                ImagePreview.zoom.animationFrameId = null;
            }
            // 添加平滑过渡效果
            activeImg.style.transition = `transform ${CONFIG.ANIMATION.DURATION}ms ${CONFIG.ANIMATION.TIMING}`;
            // 简化判断逻辑：只根据当前缩放级别判断，不再检查isZoomMode状态
            if (state.currentZoomLevel > 1) {
                // 如果当前已经放大，直接重置到原始大小
                activeImg.style.transform = '';
                // 更新状态
                store.setState({
                    currentZoomLevel: 1,
                    isZoomMode: false,
                    zoomCurrentTranslateX: 0,
                    zoomCurrentTranslateY: 0,
                    isPinching: false,
                    isDragging: false
                });
                modalContent.style.cursor = '';
            } else {
                // 如果当前未放大，则放大
                const renderedRect = activeImg.getBoundingClientRect();
                const containerRect = modalContent.getBoundingClientRect();
                // 计算缩放比例
                const scaleX = containerRect.width / renderedRect.width;
                const scaleY = containerRect.height / renderedRect.height;
                const scale = Math.min(Math.max(scaleX, scaleY), CONFIG.ZOOM.MAX);

                // 应用缩放
                activeImg.style.transform = `scale(${scale})`;
                store.setState({
                    currentZoomLevel: scale,
                    isZoomMode: true,
                    zoomCurrentTranslateX: 0,
                    zoomCurrentTranslateY: 0,
                    isPinching: false,
                    isDragging: false
                });
                modalContent.style.cursor = 'grab';
            }

            // 重置拖拽状态
            ImagePreview.zoom.zoomDragging = false;

            // 动画结束后移除过渡效果
            setTimeout(() => {
                activeImg.style.transition = '';
            }, CONFIG.ANIMATION.DURATION);
        }
    };

    // 初始化程序 - **改为DOMContentLoaded**
    document.addEventListener('DOMContentLoaded', function() {
        ImagePreview.init();
    });
})();
