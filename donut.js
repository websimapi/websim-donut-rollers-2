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
        
        // Reset physics state completely
        this.body.quaternion.set(0, 0, 0, 1);
        this.body.position.copy(this.basePosition);
        this.meshGroup.position.copy(this.basePosition);
        
        this.world.addBody(this.body);
        // Initial "Peel out" spin - faster start
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
            const speed = vel.length();
            
            // --- Path-following: steer velocity along drawn path ---
            if (this.pathFollowActive && this.pathPoints.length >= 2) {
                const currentPos = this.body.position;
                let target = this.pathPoints[this.pathIndex];

                // Advance along path when close to current target
                const dx = target.x - currentPos.x;
                const dz = target.z - currentPos.z;
                const distXZ = Math.hypot(dx, dz);

                if (distXZ < 1.0 && this.pathIndex < this.pathPoints.length - 1) {
                    this.pathIndex++;
                    target = this.pathPoints[this.pathIndex];
                }

                // Compute direction in XZ plane
                const dir = new CANNON.Vec3(
                    target.x - currentPos.x,
                    0,
                    target.z - currentPos.z
                );
                const dirLen = Math.hypot(dir.x, dir.z);

                if (dirLen > 0.001) {
                    dir.scale(1 / dirLen, dir);

                    // Align horizontal velocity with path direction
                    const horizSpeed = Math.hypot(vel.x, vel.z);
                    
                    // Boost Speed: actively accelerate when on a path
                    // Ensure we are always faster than base rolling, and accelerating
                    let desiredSpeed = horizSpeed + 0.8; 
                    if (desiredSpeed < 25) desiredSpeed = 25; // Minimum "Zoom" speed on lines
                    if (desiredSpeed > 50) desiredSpeed = 50; // Hard cap to prevent game breaking

                    vel.x = dir.x * desiredSpeed;
                    vel.z = dir.z * desiredSpeed;

                    // Spin consistent with linear speed (approximate rolling radius)
                    const rollRadius = 1.3;
                    const omegaMag = desiredSpeed / rollRadius;
                    const axleDir = new CANNON.Vec3(1, 0, 0);
                    this.body.quaternion.vmult(new CANNON.Vec3(1,0,0), axleDir);
                    axleDir.normalize();
                    this.body.angularVelocity.set(
                        axleDir.x * omegaMag,
                        axleDir.y * omegaMag,
                        axleDir.z * omegaMag
                    );
                }

                // Stop following when we reach final point
                const finalTarget = this.pathPoints[this.pathPoints.length - 1];
                const fx = finalTarget.x - currentPos.x;
                const fz = finalTarget.z - currentPos.z;
                if (Math.hypot(fx, fz) < 1.0 && this.pathIndex >= this.pathPoints.length - 1) {
                    this.pathFollowActive = false;
                    console.log('[Donut] Path follow complete');
                }
            }
            
            // --- Determine Axle and Up ---
            const axle = new CANNON.Vec3(1, 0, 0);
            this.body.quaternion.vmult(axle, axle);
            const up = new CANNON.Vec3(0, 1, 0);

            // --- Check Stability (Flattening Logic) ---
            // Dot product of Axle and Up. 0 = Horizontal (Good), 1 or -1 = Vertical (Fallen)
            const tilt = axle.dot(up);
            
            // Penny Flatten Logic:
            // If tilt > 0.7 (approx 45 degrees) AND we aren't boosting, we start to lose it.
            // If speed is low, it's easier to fall.
            if (!this.boostActive && Math.abs(tilt) > 0.8) {
                this.isFlattening = true;
            }

            // If flattening, we stop the "ball" behavior and let friction kill it
            if (this.isFlattening) {
                // Apply heavy angular damping to stop rolling
                this.body.angularDamping = 0.9;
                this.body.linearDamping = 0.5;
                
                // No stabilization torque -> let it fall
                // It will naturally hit the inner cylinder collider
                
                // If basically stopped, mark as fallen
                if (speed < 0.5) {
                    this.body.angularVelocity.set(0,0,0);
                    this.body.velocity.set(0,0,0);
                    this.hasFallen = true;
                }
            } else {
                // --- NORMAL ROLLING PHYSICS ---
                this.body.angularDamping = 0.1;
                this.body.linearDamping = 0.01;

                // 1. STABILIZATION TORQUE (Keep Axle Horizontal)
                // Use the sphere like a wheel. 
                // We apply torque to rotate the sphere towards upright.
                
                const correctionAxis = new CANNON.Vec3();
                axle.cross(up, correctionAxis); // Vector pointing forward/backward
                correctionAxis.normalize();
                
                // Strength of correction depends on speed. 
                // Gyroscopic effect: Faster = More stable.
                const stabilityForce = 200 + (speed * 20);
                
                // Apply torque proportional to tilt (Inverted sign to oppose tilt)
                // We want to push the axle back to the horizontal plane
                const correctionTorque = correctionAxis.scale(-tilt * stabilityForce);
                this.body.torque.vadd(correctionTorque, this.body.torque);

                // 2. WOBBLE DAMPING
                // Remove angular velocity that isn't along the axle (rolling) or global Y (turning)
                const omega = this.body.angularVelocity;
                const omegaAxle = axle.clone().scale(omega.dot(axle)); // Rolling spin
                const omegaWobble = omega.vsub(omegaAxle); // Everything else
                
                // Dampen the wobble strongly to prevent "death wobble"
                this.body.torque.vsub(omegaWobble.scale(80), this.body.torque);
                
                // 3. STEERING TORQUE
                // Rotate around Global Y (Yaw)
                if (Math.abs(this.steeringInput) > 0.01) {
                    const steerStrength = 15;
                    // Tilt the donut into the turn slightly?
                    // For now just yaw torque
                    this.body.torque.y -= this.steeringInput * steerStrength;
                }
                
                // 4. BOOST & MOVEMENT
                if (this.boostActive) {
                    this.boostElapsed += dt;
                    const progress = this.boostElapsed / this.boostDuration;
                    if (progress < 1.0) {
                        const eased = 1 - Math.pow(1 - progress, 3);
                        const currentBoost = this.boostMagnitude * (1 - eased);
                        const force = this.boostDirection.clone().scale(currentBoost * this.body.mass);
                        this.body.applyForce(force, this.body.position);
                    } else {
                        this.boostActive = false;
                    }
                }
                
                // 5. Downforce (Grip)
                // Keeps the donut grounded on slopes
                this.body.applyForce(new CANNON.Vec3(0, -25 * this.body.mass, 0), this.body.position);
            }

            // --- Velocity Clamping ---
            // Keep overall speed under control to avoid crazy launches from terrain bumps
            const maxSpeed = 45; // Increased significantly to allow fast gameplay
            if (speed > maxSpeed) {
                const scale = maxSpeed / speed;
                vel.scale(scale, vel);
            }
            // Clamp vertical velocity so we don't rocket up/down from collisions
            if (vel.y > 20) vel.y = 20;
            if (vel.y < -35) vel.y = -35;

            // Clamp Angular Velocity to prevent visual strobing and unrealistically fast spin
            const maxAngVel = 12; 
            if (this.body.angularVelocity.length() > maxAngVel) {
                const scale = maxAngVel / this.body.angularVelocity.length();
                this.body.angularVelocity.scale(scale, this.body.angularVelocity);
            }

            // --- Trail Update ---
            this.trail.update(this.meshGroup.position, this.meshGroup.quaternion);

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