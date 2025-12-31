import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Trail } from './trail.js';

export class Donut {
    constructor(scene, world, position, assets) {
        this.scene = scene;
        this.world = world;
        this.assets = assets;
        
        // State
        this.isRolling = false;
        this.steeringInput = 0;
        this.isUnstable = false;
        this.isFlattening = false;
        this.flattenFactor = 0;
        this.hasFallen = false;
        
        // Boost tracking - following swipe path
        this.boostActive = false;
        this.boostDirection = new CANNON.Vec3();
        this.boostMagnitude = 0;
        this.boostDuration = 0;
        this.boostElapsed = 0;

        // Path-following state (world-space points in CANNON.Vec3)
        this.pathPoints = [];
        this.pathIndex = 0;
        this.pathFollowActive = false;

        // Simple roll state for controlled upright spinning
        this.rollAngle = 0;
        
        // --- Visuals ---
        this.basePosition = position.clone();
        this.meshGroup = new THREE.Group();
        this.meshGroup.position.copy(position);
        
        // 1. Torus (Visual Body)
        const geometry = new THREE.TorusGeometry(1, 0.45, 16, 40);
        geometry.rotateY(Math.PI / 2); 

        const texture = new THREE.TextureLoader().load('./donut_texture.png');
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.rotation = Math.PI / 2; 
        
        const material = new THREE.MeshStandardMaterial({ 
            map: texture,
            roughness: 0.2,
            metalness: 0.1
        });

        this.torus = new THREE.Mesh(geometry, material);
        this.torus.castShadow = true;
        this.meshGroup.add(this.torus);

        this._addCharacterFeatures();
        
        // Orient the whole group to face camera initially (Idle state)
        this.meshGroup.rotation.set(0, 0, 0); 

        scene.add(this.meshGroup);

        // --- Trail ---
        this.trail = new Trail(scene, 0xffffff);

        // --- Physics ---
        // Use a wheel-like donut body:
        // 1. A main Cylinder aligned with the visual torus rim
        // 2. A few small rim spheres to approximate a torus and keep contact stable
        
        // Approximate torus dimensions
        const torusRadius = 1.0;   // from TorusGeometry
        const tubeRadius  = 0.45;
        const outerRadius = torusRadius + tubeRadius * 0.6; // a bit inside the visual edge
        
        this.body = new CANNON.Body({
            mass: 50,
            material: new CANNON.Material({ friction: 0.35, restitution: 0.0 })
        });
        
        // Main wheel cylinder (axis along X to match visual)
        const wheelShape = new CANNON.Cylinder(outerRadius, outerRadius, tubeRadius * 2.0, 20);
        const qWheel = new CANNON.Quaternion();
        // Rotate so cylinder's Y-axis aligns with world X-axis (wheel axle)
        qWheel.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), -Math.PI / 2);
        this.body.addShape(wheelShape, new CANNON.Vec3(0, 0, 0), qWheel);

        // Add a few small spheres around the rim to better approximate a torus contact
        const rimRadius = outerRadius;
        const rimBallRadius = tubeRadius * 0.7;
        const rimOffsets = [
            new CANNON.Vec3(0, 0,  rimRadius),
            new CANNON.Vec3(0, 0, -rimRadius),
            new CANNON.Vec3(0,  rimRadius, 0),
            new CANNON.Vec3(0, -rimRadius, 0)
        ];
        const rimBallShape = new CANNON.Sphere(rimBallRadius);
        rimOffsets.forEach((offset) => {
            this.body.addShape(rimBallShape, offset);
        });

        this.body.position.copy(position);
        
        // Damping tuned for stable rolling without jitter
        this.body.linearDamping = 0.35;
        this.body.angularDamping = 0.25;
        
        // CCD to prevent tunneling at high speeds
        this.body.ccdSpeedThreshold = 1.0;
        this.body.ccdIterations = 5;
    }

    _addCharacterFeatures() {
        this.eyesGroup = new THREE.Group();
        const eyeGeo = new THREE.SphereGeometry(0.12, 16, 16);
        const eyeMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
        
        const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
        leftEye.position.set(0, 0.3, -0.35);
        const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
        rightEye.position.set(0, 0.3, 0.35);
        
        const shineGeo = new THREE.SphereGeometry(0.04, 8, 8);
        const shineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const leftShine = new THREE.Mesh(shineGeo, shineMat);
        leftShine.position.set(0.1, 0.04, -0.04);
        const rightShine = new THREE.Mesh(shineGeo, shineMat);
        rightShine.position.set(0.1, 0.04, -0.04);
        
        leftEye.add(leftShine);
        rightEye.add(rightShine);
        
        this.eyesGroup.add(leftEye, rightEye);
        this.eyesGroup.position.set(0.42, 0, 0);
        this.meshGroup.add(this.eyesGroup);

        this.limbsGroup = new THREE.Group();
        const limbMat = new THREE.MeshStandardMaterial({ color: 0xd2b48c }); 
        const limbGeo = new THREE.CapsuleGeometry(0.1, 0.6, 4, 8);
        
        this.legL = new THREE.Mesh(limbGeo, limbMat);
        this.legL.position.set(0, -1.3, -0.4);
        this.legR = new THREE.Mesh(limbGeo, limbMat);
        this.legR.position.set(0, -1.3, 0.4);
        
        this.armL = new THREE.Mesh(limbGeo, limbMat);
        this.armL.position.set(0, 0, -1.2);
        this.armL.rotation.x = -Math.PI / 4;
        
        this.armR = new THREE.Mesh(limbGeo, limbMat);
        this.armR.position.set(0, 0, 1.2);
        this.armR.rotation.x = Math.PI / 4;

        this.limbsGroup.add(this.legL, this.legR, this.armL, this.armR);
        this.meshGroup.add(this.limbsGroup);
    }

    startRolling() {
        this.isRolling = true;
        this.isUnstable = false;
        this.isFlattening = false;
        this.hasFallen = false;
        this.trail.reset();
        
        this.meshGroup.rotation.set(0, 0, 0); 

        // Reset roll state
        this.rollAngle = 0;
        
        // Reset physics state completely
        this.body.quaternion.set(0, 0, 0, 1);
        this.body.position.copy(this.basePosition);
        this.meshGroup.position.copy(this.basePosition);
        
        this.world.addBody(this.body);
        // Initial straight launch downhill
        this.body.velocity.set(0, 0, 15);
        this.body.angularVelocity.set(10, 0, 0); 

        this.assets.playSound('jump');
        this.assets.playLoop('roll');
    }

    // New boost system - follows 3D world direction
    boost(directionVector, intensity) {
        if (!this.isRolling || this.isFlattening) return;
        
        // Ensure direction is normalized
        const inputDir = new CANNON.Vec3(directionVector.x, 0, directionVector.z);
        inputDir.normalize();
        
        console.log(`[Donut] Boost World Dir: ${inputDir.x.toFixed(2)}, ${inputDir.y.toFixed(2)}, ${inputDir.z.toFixed(2)} | Intensity: ${intensity.toFixed(2)}`);

        // Calculate boost params
        const maxBoostDuration = 0.4; 
        const minBoostDuration = 0.08; 
        this.boostDuration = minBoostDuration + (intensity * (maxBoostDuration - minBoostDuration));
        
        // Reduced boost power to keep speed manageable
        const baseBoost = 3; 
        const maxBoost = 6; 
        this.boostMagnitude = baseBoost + (intensity * (maxBoost - baseBoost));
        
        this.boostDirection.copy(inputDir);
        this.boostActive = true;
        this.boostElapsed = 0;
        
        // --- Strong Orientation Correction on Boost ---
        // Auto-align the physics velocity to the swipe direction to ensure we follow the path
        const speed = this.body.velocity.length();
        if (speed > 1) {
            const newVel = inputDir.clone().scale(speed);
            this.body.velocity.copy(newVel);
        }
        
        // Reset instability
        this.isUnstable = false;
        this.isFlattening = false;
        this.flattenFactor = 0;
        
        this.assets.playSound('jump');
    }

    // Configure a new world-space path for the donut to follow
    setPath(threePoints) {
        if (!this.isRolling || !threePoints || threePoints.length < 2) return;

        this.pathPoints = threePoints.map(p => new CANNON.Vec3(p.x, p.y, p.z));
        this.pathIndex = 0;
        this.pathFollowActive = true;
        this.boostActive = false; // hand control over to path-follow
        console.log(`[Donut] Path set with ${this.pathPoints.length} points`);
    }

    update(time, dt) {
        if (!this.isRolling) {
            // Idle Animation
            const bounce = Math.sin(time * 3) * 0.1;
            this.meshGroup.position.y = this.body.position.y + bounce;
            
            this.armL.rotation.x = (-Math.PI / 4) + Math.sin(time * 4) * 0.1;
            this.armR.rotation.x = (Math.PI / 4) - Math.sin(time * 4) * 0.1;
            this.legL.rotation.z = Math.sin(time * 4) * 0.2;
            this.legR.rotation.z = Math.cos(time * 4) * 0.2;
        } else {
            const vel = this.body.velocity;

            // Force motion to stay roughly straight downhill along +Z
            // No sideways drift; never roll backwards up the hill.
            vel.x = 0;
            if (vel.z < 0) vel.z = -vel.z;

            const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);

            // No steering torque or tilt logic – keep donut upright and simple
            this.body.angularDamping = 0.1;
            this.body.linearDamping = 0.01;
            this.body.torque.set(0, 0, 0);

            // Simple boost: still allow forward boosts if active
            if (this.boostActive) {
                this.boostElapsed += dt;
                const progress = this.boostElapsed / this.boostDuration;
                if (progress < 1.0) {
                    const eased = 1 - Math.pow(1 - progress, 3);
                    const currentBoost = this.boostMagnitude * (1 - eased);
                    const force = new CANNON.Vec3(0, 0, 1).scale(currentBoost * this.body.mass);
                    this.body.applyForce(force, this.body.position);
                } else {
                    this.boostActive = false;
                }
            }

            // Downforce to keep it planted
            this.body.applyForce(new CANNON.Vec3(0, -25 * this.body.mass, 0), this.body.position);

            // --- Velocity Clamping ---
            const maxSpeed = 45;
            if (speed > maxSpeed) {
                const scale = maxSpeed / speed;
                vel.scale(scale, vel);
            }
            if (vel.y > 20) vel.y = 20;
            if (vel.y < -35) vel.y = -35;

            // --- Locked Upright Rolling ---
            const rollRadius = 1.3;
            this.rollAngle = (this.rollAngle + (speed * dt) / rollRadius) % (Math.PI * 2);

            // Build upright quaternion that only spins around the X axle
            const q = new CANNON.Quaternion();
            q.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), this.rollAngle);
            this.body.quaternion.copy(q);

            // Angular velocity strictly around the axle, matching linear speed
            const omega = speed / rollRadius;
            this.body.angularVelocity.set(omega, 0, 0);

            // --- Trail Update using physics transform ---
            this.trail.update(this.body.position, this.body.quaternion);

            // --- Sync Visuals ---
            if (!isNaN(this.body.position.x)) {
                this.meshGroup.position.copy(this.body.position);
                this.meshGroup.quaternion.copy(this.body.quaternion);
            }
            
            if (this.limbsGroup.visible) {
                this.limbsGroup.visible = false;
            }
        }
    }

    getPosition() {
        return this.body.position;
    }

    resetPhysicsPosition() {
        // Reset to the initial spawn anchor, ignoring any visual bounding/offsets
        this.body.position.copy(this.basePosition);
        this.body.velocity.set(0,0,0);
        this.body.angularVelocity.set(0,0,0);
    }
}