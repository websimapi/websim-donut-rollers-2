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

        // Visual heading & banking (smooth turn animations)
        this.visualYaw = 0;
        this.targetYaw = 0;
        this.currentBank = 0;
        
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
        
        // Damping tuned for stable, smooth rolling with less jitter and bounce
        this.body.linearDamping = 0.45;
        this.body.angularDamping = 0.35;
        
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
        this.visualYaw = 0;
        this.targetYaw = 0;
        this.currentBank = 0;
        
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
            const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);

            // --- Path Following / Speed Boost on Path ---
            if (this.pathFollowActive && this.pathPoints.length >= 2) {
                const pos = this.body.position;
                const lastIdx = this.pathPoints.length - 1;

                // Advance index roughly with forward progress
                while (this.pathIndex < lastIdx - 1 && pos.z > this.pathPoints[this.pathIndex + 1].z) {
                    this.pathIndex++;
                }

                // Find closest point ahead within a small window
                let closestIdx = this.pathIndex;
                let closestDistSq = Infinity;
                for (let i = this.pathIndex; i <= Math.min(lastIdx, this.pathIndex + 20); i++) {
                    const p = this.pathPoints[i];
                    const dx = pos.x - p.x;
                    const dz = pos.z - p.z;
                    const d2 = dx * dx + dz * dz;
                    if (d2 < closestDistSq) {
                        closestDistSq = d2;
                        closestIdx = i;
                    }
                }
                this.pathIndex = closestIdx;

                const onPath = closestDistSq < (5 * 5); // within 5m of path center

                if (this.pathIndex < lastIdx) {
                    const curr = this.pathPoints[this.pathIndex];
                    const next = this.pathPoints[this.pathIndex + 1];

                    // Tangent direction along the path, flattened to XZ
                    const dirX = next.x - curr.x;
                    const dirZ = next.z - curr.z;
                    const len = Math.hypot(dirX, dirZ);

                    if (len > 0.0001) {
                        const nx = dirX / len;
                        const nz = dirZ / len;

                        // Base desired speed at least equal to current, with extra when on path
                        let desiredSpeed = Math.max(speed, 20);
                        if (onPath) {
                            desiredSpeed += 10; // extra push when we ride the line
                        }

                        // Desired velocity along the path
                        const targetVx = nx * desiredSpeed;
                        const targetVz = nz * desiredSpeed;

                        // Smoothly accelerate toward desired velocity instead of snapping
                        const dvx = targetVx - vel.x;
                        const dvz = targetVz - vel.z;

                        // Slightly softer steering forces for smoother following
                        const alignStrength = onPath ? 3.5 : 2.0;
                        const mass = this.body.mass;

                        // Apply force in XZ plane to steer toward path direction
                        const forceDir = new CANNON.Vec3(dvx * alignStrength * mass, 0, dvz * alignStrength * mass);
                        this.body.applyForce(forceDir, this.body.position);

                        // Gentle attraction back toward the path center line
                        const p = this.pathPoints[this.pathIndex];
                        const offsetX = p.x - pos.x;
                        const offsetZ = p.z - pos.z;

                        // Component of offset perpendicular to path tangent
                        const proj = offsetX * nx + offsetZ * nz;
                        const perpX = offsetX - proj * nx;
                        const perpZ = offsetZ - proj * nz;

                        const distPerpSq = perpX * perpX + perpZ * perpZ;
                        if (distPerpSq > 0.0001) {
                            const distPerp = Math.sqrt(distPerpSq);
                            const maxPull = 10;
                            const pullStrength = Math.min(maxPull, distPerp * 2.5);
                            const pullX = (perpX / distPerp) * pullStrength * mass;
                            const pullZ = (perpZ / distPerp) * pullStrength * mass;
                            this.body.applyForce(new CANNON.Vec3(pullX, 0, pullZ), this.body.position);
                        }

                        // Smoothly steer visual heading toward path direction
                        this.targetYaw = Math.atan2(nx, nz);
                    }
                }

                // Stop following once we've clearly passed the end of the path
                if (pos.z > this.pathPoints[lastIdx].z + 10) {
                    this.pathFollowActive = false;
                }
            } else {
                // When not following a path, point roughly where we're moving
                if (speed > 0.5) {
                    this.targetYaw = Math.atan2(vel.x, vel.z);
                }
            }

            // Basic damping; let physics handle the tilt and motion
            // Higher damping here smooths motion and reduces jitter
            this.body.angularDamping = 0.4;
            this.body.linearDamping = 0.3;
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

            // Downforce to keep it planted (reduced a bit to avoid jerky bounces)
            this.body.applyForce(new CANNON.Vec3(0, -15 * this.body.mass, 0), this.body.position);

            // --- Velocity Clamping ---
            const maxSpeed = 45;
            if (speed > maxSpeed) {
                const scale = maxSpeed / speed;
                vel.scale(scale, vel);
            }
            if (vel.y > 20) vel.y = 20;
            if (vel.y < -35) vel.y = -35;

            // --- Locked Upright Rolling with Visual Heading & Banking ---
            const rollRadius = 1.3;
            this.rollAngle = (this.rollAngle + (speed * dt) / rollRadius) % (Math.PI * 2);

            // Physics stays as a simple upright wheel rolling around X
            const q = new CANNON.Quaternion();
            q.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), this.rollAngle);
            this.body.quaternion.copy(q);

            // Angular velocity strictly around the axle, matching linear speed
            const omega = speed / rollRadius;
            this.body.angularVelocity.set(omega, 0, 0);

            // --- Trail Update using physics transform (convert CANNON to THREE) ---
            const trailPos = new THREE.Vector3(
                this.body.position.x,
                this.body.position.y,
                this.body.position.z
            );
            const trailQuat = new THREE.Quaternion(
                this.body.quaternion.x,
                this.body.quaternion.y,
                this.body.quaternion.z,
                this.body.quaternion.w
            );
            this.trail.update(trailPos, trailQuat);

            // --- Sync Visuals with smooth heading and banking ---
            if (!isNaN(this.body.position.x)) {
                this.meshGroup.position.copy(this.body.position);

                // Smoothly interpolate visual yaw toward the target yaw
                const yawLerp = 1 - Math.exp(-8 * dt);
                // Use THREE's angle lerp to handle wrap-around correctly
                this.visualYaw = THREE.MathUtils.lerpAngle(this.visualYaw, this.targetYaw || 0, yawLerp);

                // Compute turn sharpness for extra lean on tight turns
                let angleDelta = this.targetYaw - this.visualYaw;
                angleDelta = Math.atan2(Math.sin(angleDelta), Math.cos(angleDelta)); // wrap to [-PI, PI]

                // Heading-right vector in XZ plane (for lateral speed)
                const headingRightX = Math.sin(this.visualYaw + Math.PI / 2);
                const headingRightZ = Math.cos(this.visualYaw + Math.PI / 2);
                const lateralSpeed = this.body.velocity.x * headingRightX + this.body.velocity.z * headingRightZ;

                const maxBank = 0.7; // radians
                let desiredBank = lateralSpeed * 0.04 + angleDelta * 0.5; // extra lean for sharp turns
                desiredBank = THREE.MathUtils.clamp(desiredBank, -maxBank, maxBank);

                // Smooth bank transitions
                const bankLerp = 1 - Math.exp(-10 * dt);
                this.currentBank = THREE.MathUtils.lerp(this.currentBank, desiredBank, bankLerp);

                // Base roll from physics (around local X)
                const rollQuat = new THREE.Quaternion();
                rollQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.rollAngle);

                // Yaw to face direction of travel / path
                const yawQuat = new THREE.Quaternion();
                yawQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.visualYaw);

                // Bank around local Z axis so the donut leans into the turn
                const bankQuat = new THREE.Quaternion();
                bankQuat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -this.currentBank);

                const finalQuat = yawQuat.multiply(rollQuat).multiply(bankQuat);
                this.meshGroup.quaternion.copy(finalQuat);
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