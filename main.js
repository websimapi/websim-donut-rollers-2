import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Donut } from './donut.js';
import { InfiniteTerrain } from './terrain.js';

// --- Setup ---
const container = document.getElementById('game-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB);
// Increased fog distance for "expansive" feel
// Using a slightly different fog color to debug vs background if needed, but keeping it pretty
scene.fog = new THREE.Fog(0x87CEEB, 20, 300);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

// Lights
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(50, 100, 50);
dirLight.castShadow = true;
// Increase shadow frustum to cover terrain
dirLight.shadow.camera.left = -50;
dirLight.shadow.camera.right = 50;
dirLight.shadow.camera.top = 50;
dirLight.shadow.camera.bottom = -50;
dirLight.shadow.camera.near = 1;
dirLight.shadow.camera.far = 300;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
scene.add(dirLight);

// Physics World
const world = new CANNON.World();
world.gravity.set(0, -35, 0); // Softer gravity to reduce violent bounces
world.solver.iterations = 30; // More iterations for smoother contacts
world.defaultContactMaterial.friction = 0.4; // Slightly higher friction for smoother sliding
world.defaultContactMaterial.restitution = 0.0; // No bounce

 // --- Game State ---
let gameState = 'IDLE'; // IDLE, STARTING, PLAYING, GAME_OVER
let input = { x: 0 }; // -1 to 1
let stoppedTime = 0; // how long we've been basically stopped

// Path drawing energy (meters of path available)
const maxPathCharge = 100;
let pathCharge = maxPathCharge;
let currentGesturePathLength = 0;

// Path bar UI
const pathBar = document.getElementById('path-bar');
const pathBarFill = document.getElementById('path-bar-fill');

// --- Audio System ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const assets = {
    sounds: {},
    playSound: (id) => {
        if (!assets.sounds[id]) return;
        const source = audioCtx.createBufferSource();
        source.buffer = assets.sounds[id];
        source.connect(audioCtx.destination);
        source.start(0);
    },
    playLoop: (id) => {
        if (!assets.sounds[id]) return;
        const source = audioCtx.createBufferSource();
        source.buffer = assets.sounds[id];
        source.connect(audioCtx.destination);
        source.loop = true;
        source.start(0);
        return source; 
    }
};

async function loadAudio(url, id) {
    try {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        assets.sounds[id] = audioBuffer;
    } catch(e) {
        console.warn("Audio load failed", e);
    }
}

loadAudio('./jump.mp3', 'jump');
loadAudio('./rolling_loop.mp3', 'roll');
loadAudio('./music_loop.mp3', 'music');

// --- Game Objects ---
const terrain = new InfiniteTerrain(scene, world);

// Calculate start height based on terrain at 0,0
// Start closer to ground for a smooth roll-out (Donut radius approx 1.3)
const startY = terrain.getHeightAt(0, 0) + 1.5; 
const donut = new Donut(scene, world, new THREE.Vector3(0, startY, 0), assets);

 // --- 3D Path Visualization ---
let pathLine = null;
let pathPoints3D = [];

function createPathLine() {
    if (pathLine) {
        scene.remove(pathLine);
        pathLine.geometry.dispose();
    }
    if (pathPoints3D.length < 2) return;

    const geometry = new THREE.BufferGeometry().setFromPoints(pathPoints3D);
    const material = new THREE.LineBasicMaterial({ 
        color: 0xff69b4, 
        linewidth: 5,
        transparent: true,
        opacity: 0.8
    });
    
    pathLine = new THREE.Line(geometry, material);
    scene.add(pathLine);
}

function clearPathLine() {
    if (pathLine) {
        scene.remove(pathLine);
        pathLine.geometry.dispose();
        pathLine = null;
    }
    pathPoints3D = [];
}

// --- Input Handling ---
function handleInput(x) {
    input.x = x;
}

// Raycaster for screen to world projection
const raycaster = new THREE.Raycaster();

function screenToWorld(screenX, screenY) {
    // Convert screen coordinates to normalized device coordinates
    const x = (screenX / window.innerWidth) * 2 - 1;
    const y = -(screenY / window.innerHeight) * 2 + 1;
    
    raycaster.setFromCamera({ x, y }, camera);
    
    const ray = raycaster.ray;
    
    // Intersect with approximate ground plane at donut's current base height
    // This allows the ray to travel "into" the screen (Z-depth) properly
    const groundY = donut.getPosition().y - 1.0;
    
    // t = (targetY - originY) / dirY
    if (Math.abs(ray.direction.y) > 0.001) {
        const t = (groundY - ray.origin.y) / ray.direction.y;
        if (t > 0) {
            const worldX = ray.origin.x + ray.direction.x * t;
            const worldZ = ray.origin.z + ray.direction.z * t;
            
            // Refine height based on actual terrain at this X,Z
            const terrainY = terrain.getHeightAt(worldX, worldZ);
            return new THREE.Vector3(worldX, terrainY + 0.3, worldZ);
        }
    }
    return null;
}

// Gesture State
const gesture = {
    active: false,
    startX: 0,
    startY: 0,
    points: [],
    startTime: 0
};
const swipePath = document.getElementById('swipe-path');

function updateSwipeVisuals() {
    // If not actively drawing, or not enough points, or no charge left,
    // just clear the on-screen stroke but keep any existing 3D path line.
    if (!gesture.active || gesture.points.length < 2 || pathCharge <= 0) {
        swipePath.setAttribute('d', '');
        return;
    }

    // --- Build 3D path with length limited by available charge ---
    let newPath3D = [];
    let usedGesturePoints = [];
    let accumulatedLen = 0;
    let lastWorld = null;

    for (let i = 0; i < gesture.points.length; i++) {
        const p2d = gesture.points[i];
        const world = screenToWorld(p2d.x, p2d.y);
        if (!world) continue;

        if (lastWorld) {
            const segLen = world.distanceTo(lastWorld);
            if (accumulatedLen + segLen > pathCharge) {
                break; // cannot draw beyond available charge
            }
            accumulatedLen += segLen;
        }

        newPath3D.push(world);
        usedGesturePoints.push(p2d);
        lastWorld = world;
    }

    // Trim gesture points to what we can afford
    gesture.points = usedGesturePoints;
    currentGesturePathLength = accumulatedLen;

    // Update 2D SVG path from trimmed gesture.points
    if (gesture.points.length >= 2) {
        const d = gesture.points.reduce((acc, p, i) => {
            return acc + (i === 0 ? `M ${p.x} ${p.y}` : ` L ${p.x} ${p.y}`);
        }, '');
        swipePath.setAttribute('d', d);
    } else {
        swipePath.setAttribute('d', '');
    }

    // Update 3D terrain path
    if (gameState === 'PLAYING') {
        pathPoints3D = newPath3D;
        if (pathPoints3D.length >= 2) {
            createPathLine();
        }
    }
}

function endGesture() {
    if (!gesture.active) return;
    
    const dt = performance.now() - gesture.startTime;
    const endP = gesture.points[gesture.points.length - 1];
    if (!endP) return;

    const dx = endP.x - gesture.startX;
    const dy = endP.y - gesture.startY;
    const dist = Math.sqrt(dx*dx + dy*dy);
    
    if (gameState === 'PLAYING') {
        console.log(`[Gesture] End. dx=${dx.toFixed(1)}, dy=${dy.toFixed(1)}, dist=${dist.toFixed(1)}, dt=${dt.toFixed(0)}ms`);

        // Use 3D projected path for accurate direction relative to terrain/camera
        if (pathPoints3D.length >= 2) {
            console.log(`[Gesture] Path Action 3D. points=${pathPoints3D.length}`);
            donut.setPath(pathPoints3D);
        } else if (dist > 30) {
            // Fallback to screen space if 3D projection failed
            const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
            camForward.y = 0; 
            camForward.normalize();
            
            const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
            camRight.y = 0; 
            camRight.normalize();

            const maxDist = 300;
            const inputX = dx / maxDist; 
            const inputY = dy / maxDist; 

            const boostDir = new THREE.Vector3()
                .addScaledVector(camRight, inputX)
                .addScaledVector(camForward, -inputY);
            
            const intensity = Math.min(boostDir.length(), 1.0);
            if (intensity > 0.001) boostDir.normalize();

            donut.boost(boostDir, intensity);

        } else if (dt < 300) {
            // Simple Tap - Small forward hop relative to camera
            const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
            camForward.y = 0; 
            camForward.normalize();
            console.log(`[Gesture] Tap Action.`);
            donut.boost(camForward, 0.4); 
        }
    }

    gesture.active = false;
    gesture.points = [];
    updateSwipeVisuals();

    // Commit charge usage for this path
    if (gameState === 'PLAYING') {
        pathCharge = Math.max(0, pathCharge - currentGesturePathLength);
        currentGesturePathLength = 0;
    }

    // Reset steering input so we don't drift forever
    handleInput(0);
}

// Mouse Events
window.addEventListener('mousedown', (e) => {
    if(e.target.tagName === 'BUTTON') return;
    gesture.active = true;
    gesture.startTime = performance.now();
    gesture.startX = e.clientX;
    gesture.startY = e.clientY;
    gesture.points = [{x: e.clientX, y: e.clientY}];
    updateSwipeVisuals();
});

window.addEventListener('mousemove', (e) => {
    if (gesture.active) {
        gesture.points.push({x: e.clientX, y: e.clientY});
        updateSwipeVisuals();
    }
});

window.addEventListener('mouseup', endGesture);

// Touch Events
window.addEventListener('touchstart', (e) => {
    if(e.target.tagName === 'BUTTON') return;
    const t = e.touches[0];
    gesture.active = true;
    gesture.startTime = performance.now();
    gesture.startX = t.clientX;
    gesture.startY = t.clientY;
    gesture.points = [{x: t.clientX, y: t.clientY}];
    updateSwipeVisuals();
}, { passive: false });

window.addEventListener('touchmove', (e) => {
    if (e.target.id === 'game-container' || e.target.tagName === 'BODY') {
        e.preventDefault();
    }
    const t = e.touches[0];
    
    if (gesture.active) {
        gesture.points.push({x: t.clientX, y: t.clientY});
        updateSwipeVisuals();
    }
}, { passive: false });

window.addEventListener('touchend', (e) => {
    if(e.target.tagName === 'BUTTON') return;
    endGesture();
}, { passive: false });

function startGame() {
    if (gameState !== 'IDLE') return;
    
    if (audioCtx.state === 'suspended') audioCtx.resume();
    
    gameState = 'STARTING';
    
    // UI Updates
    const startText = document.getElementById('tap-to-start');
    document.getElementById('title-screen').style.display = 'none';
    startText.style.opacity = '0';
    setTimeout(() => {
        startText.style.display = 'none';
        document.getElementById('score-display').classList.remove('hidden');
        document.getElementById('controls-hint').classList.remove('hidden');
        pathBar.classList.remove('hidden');
    }, 500);

    // Start Music
    assets.playLoop('music');

    // Trigger Donut Action
    donut.startRolling();

    // Pre-drawn 100m straight path downhill for a strong start
    const startPos = donut.getPosition();
    pathPoints3D = [];
    const step = 2;
    const totalLength = 100;
    for (let s = 0; s <= totalLength; s += step) {
        const x = startPos.x;
        const z = startPos.z + s;
        const y = terrain.getHeightAt(x, z) + 0.3;
        pathPoints3D.push(new THREE.Vector3(x, y, z));
    }
    createPathLine();
    donut.setPath(pathPoints3D);

    gameState = 'PLAYING';
}

window.addEventListener('click', startGame);
window.addEventListener('touchstart', (e) => {
    // Prevent default touch behaviors on canvas
    if(e.target.tagName !== 'BUTTON') {
       startGame();
    }
}, { passive: false });

// --- Resize ---
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Main Loop ---
const clock = new THREE.Clock();
let score = 0;

function animate() {
    requestAnimationFrame(animate);

    const dt = Math.min(clock.getDelta(), 0.1); 
    const time = clock.getElapsedTime();

    // Step physics whenever the donut is active in the world
    if (gameState === 'PLAYING' || gameState === 'GAME_OVER') {
        world.step(1 / 60, dt, 5);
    }

    if (gameState === 'PLAYING') {
        // Input Physics
        donut.steeringInput = input.x;

        // Recharge path energy when not drawing
        if (!gesture.active && pathCharge < maxPathCharge) {
            // 15m per second recharge - slightly faster
            pathCharge = Math.min(maxPathCharge, pathCharge + dt * 15);
        }

        // Update path bar UI
        const chargeRatio = maxPathCharge > 0 ? (pathCharge / maxPathCharge) : 0;
        if (pathBarFill) {
            pathBarFill.style.transform = `scaleX(${chargeRatio})`;
            pathBarFill.style.opacity = chargeRatio > 0.05 ? '1' : '0.2';
        }

        // Pure Physics: We do not touch velocity manually.
        // Gravity and Terrain slope provide all acceleration.
        // This removes any "artificial force" feel.

        const vel = donut.body.velocity;

        // Update speed display (convert to MPH)
        const v = donut.body.velocity;
        const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); // units per second
        const mph = Math.round(speed * 2.23694); // 1 m/s ≈ 2.23694 mph
        score = mph;
        document.getElementById('score-val').innerText = mph;

        // Update Terrain
        const zPos = donut.getPosition().z;
        terrain.update(zPos);
        
        // --- Enhanced Bounds Checking ---
        const pos = donut.getPosition();
        const terrainY = terrain.getHeightAt(pos.x, pos.z);
        const dy = pos.y - terrainY;
        const speedSq = vel.x * vel.x + vel.y * vel.y + vel.z * vel.z;

        // Game Over if out of bounds (climbed the mountain)
        if (Math.abs(pos.x) > 70) {
            console.log("[Game] Out of bounds X - Wall Climb");
            gameState = 'GAME_OVER';
        }

        // Prevent excessive height (flying away)
        // Hard clamp to prevent glitches
        const maxHeight = terrainY + 15;
        if (pos.y > maxHeight) {
            const excessHeight = pos.y - maxHeight;
            donut.body.applyForce(
                new CANNON.Vec3(0, -excessHeight * 200 * donut.body.mass, 0),
                donut.body.position
            );
            // Kill upward velocity
            if (donut.body.velocity.y > 0) {
                donut.body.velocity.y = 0;
            }
        }

        // Game over checks
        if (dy < 2 && speedSq < 1 * 1) {
            stoppedTime += dt;
        } else {
            stoppedTime = 0;
        }

        if (stoppedTime > 2) {
            gameState = 'GAME_OVER';
        }

        // Game Over if donut has fallen over
        if (donut.hasFallen) {
            gameState = 'GAME_OVER';
        }

        if (pos.y < terrainY - 20) {
            gameState = 'GAME_OVER';
        }

        // Clear 3D path line once donut has finished following it
        if (!donut.pathFollowActive && !gesture.active && pathLine) {
            clearPathLine();
        }
    } else if (gameState === 'IDLE') {
        // Stick physics body to visual start position so it doesn't drift in void
        donut.resetPhysicsPosition();
    }

    // Object Updates
    donut.update(time, dt);

    // Camera Logic
    if (gameState === 'IDLE') {
        const radius = 10;
        camera.position.x = Math.sin(time * 0.3) * radius;
        camera.position.z = Math.cos(time * 0.3) * radius;
        if (!isNaN(donut.meshGroup.position.y)) {
             camera.position.y = donut.meshGroup.position.y + 5;
             camera.lookAt(donut.meshGroup.position);
        }
    } else if (gameState === 'PLAYING' || gameState === 'GAME_OVER') {
        const targetPos = donut.meshGroup.position;
        
        // Safety check to prevent camera NaN bugs causing black/blue screen
        if (targetPos && !isNaN(targetPos.x) && !isNaN(targetPos.y) && !isNaN(targetPos.z)) {
            // Locked camera offset for stable tracking
            // Higher and further back to keep view clear
            const offset = new THREE.Vector3(0, 15, -20); 
            
            // Rigid follow (no lerp lag) to keep donut always in view
            const camPos = new THREE.Vector3().copy(targetPos).add(offset);
            
            // Soft limits on camera height to avoid clipping terrain
            camPos.y = Math.max(targetPos.y + 5, camPos.y);

            camera.position.copy(camPos);
            camera.lookAt(targetPos);
            
            // Update Light
            dirLight.position.set(targetPos.x + 20, targetPos.y + 30, targetPos.z + 20);
            dirLight.target.position.copy(targetPos);
            dirLight.target.updateMatrixWorld();
        }
    }

    renderer.render(scene, camera);
}

animate();