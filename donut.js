import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Trail } from './trail.js';

// Local helper for smooth angle interpolation
function lerpAngle(a, b, t) {
    const diff = Math.atan2(Math.sin(b - a), Math.cos(b - a));
    return a + diff * t;
}

export class Donut {
    constructor(scene, world, position, assets) {
        this.scene = scene;
        this.world = world;
        this.assets = assets;
        
        // State
        this.isRolling = false;
        this.hasFallen = false;
        
        // Boost / Path State
        this.pathPoints = [];
        this.pathIndex = 0;
        this.pathFollowActive = false;
        
        // Visual Rotation State
        this.rollAngle = 0;
        this.visualYaw = 0;
        this.targetYaw = 0;
        this.currentBank = 0;
        
        // Penny/Wobble Effect State
        this.wobbleAngle = 0;
        this.wobbleSpeed = 0;

        // --- Visuals ---
        this.basePosition = position.clone();
        this.meshGroup = new THREE.Group();
        this.meshGroup.position.copy(position);
        
        // Torus (Visual Body) - Aligned so local X is the axle
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
        
        // Initial orientation
        this.meshGroup.rotation.set(0, 0, 0); 
        this.scene.add(this.meshGroup);

        // --- Trail ---
        this.trail = new Trail(scene, 0xffffff);

        // --- Physics ---
        // Using a Sphere for smooth, non-frantic rolling physics
        // The visual torus "floats" inside this sphere approximation
        const radius = 1.35; 
        const sphereShape = new CANNON.Sphere(radius);
        
        this.body = new CANNON.Body({
            mass: 50,
            material: new CANNON.Material({ friction: 0.3, restitution: 0.1 })
        });
        
        this.body.addShape(sphereShape);
        this.body.position.copy(position);
        
        // Damping to keep it controllable
        this.body.linearDamping = 0.1;
        this.body.angularDamping = 0.6; // Higher angular damping to prevent spin chaos
        
        // Treat as a sliding rolling object
        this.body.fixedRotation = false; 
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
        this.hasFallen = false;
        this.trail.reset();
        
        // Reset Visuals
        this.meshGroup.rotation.set(0, 0, 0); 
        this.rollAngle = 0;
        this.visualYaw = 0;
        this.targetYaw = 0;
        this.currentBank = 0;
        this.wobbleAngle = 0;
        
        // Reset Physics
        this.body.velocity.set(0, 0, 15);
        this.body.angularVelocity.set(0, 0, 0);
        this.body.position.copy(this.basePosition);
        
        // Ensure body is in world
        if(this.world.bodies.indexOf(this.body) === -1) {
            this.world.addBody(this.body);
        }

        this.assets.playSound('jump');
        this.assets.playLoop('roll');
    }

    // Boost now simply redirects velocity for immediate responsiveness
    boost(directionVector, intensity) {
        if (!this.isRolling || this.hasFallen) return;
        
        const inputDir = new CANNON.Vec3(directionVector.x, 0, directionVector.z);
        inputDir.normalize();
        
        // Add speed and redirect
        const currentSpeed = this.body.velocity.length();
        const baseBoost = 5;
        const newSpeed = Math.max(currentSpeed, 10) + (baseBoost * intensity);
        
        // Smoothly blend current direction with input
        // But for a tap/swipe, immediate response is often better
        const newVel = inputDir.scale(newSpeed);
        this.body.velocity.copy(newVel);
        
        // Also update visual target immediately
        this.targetYaw = Math.atan2(inputDir.x, inputDir.z);
        
        this.pathFollowActive = false; // Manual override disables path follow
        this.assets.playSound('jump');
    }

    setPath(threePoints) {
        if (!this.isRolling || !threePoints || threePoints.length < 2) return;
        this.pathPoints = threePoints.map(p => new CANNON.Vec3(p.x, p.y, p.z));
        this.pathIndex = 0;
        this.pathFollowActive = true;
    }

    update(time, dt) {
        if (!this.isRolling) {
            // Idle Animation
            const bounce = Math.sin(time * 3) * 0.1;
            this.meshGroup.position.y = this.body.position.y + bounce;
            // Simple limb anims
            this.armL.rotation.x = (-Math.PI / 4) + Math.sin(time * 4) * 0.1;
            this.armR.rotation.x = (Math.PI / 4) - Math.sin(time * 4) * 0.1;
            return;
        }

        const vel = this.body.velocity;
        const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
        const pos = this.body.position;

        // --- Path Following (Steering) ---
        if (this.pathFollowActive && this.pathPoints.length >= 2) {
            // Find closest point (simple search forward)
            let closestIdx = this.pathIndex;
            let minD2 = Infinity;
            const limit = Math.min(this.pathPoints.length, this.pathIndex + 20);
            
            for (let i = this.pathIndex; i < limit; i++) {
                const p = this.pathPoints[i];
                const d2 = (pos.x - p.x)**2 + (pos.z - p.z)**2;
                if (d2 < minD2) {
                    minD2 = d2;
                    closestIdx = i;
                }
            }
            this.pathIndex = closestIdx;

            // Look ahead for target direction
            // Look roughly 10-15 units ahead
            let targetIdx = closestIdx;
            let lookAheadDist = 0;
            const desiredLookAhead = 15.0;
            
            while(targetIdx < this.pathPoints.length - 1 && lookAheadDist < desiredLookAhead) {
                lookAheadDist += this.pathPoints[targetIdx].distanceTo(this.pathPoints[targetIdx+1]);
                targetIdx++;
            }

            const targetP = this.pathPoints[targetIdx];
            
            // Vector to target
            const dx = targetP.x - pos.x;
            const dz = targetP.z - pos.z;
            const dist = Math.hypot(dx, dz);

            if (dist > 0.1) {
                // Desired direction
                const dirX = dx / dist;
                const dirZ = dz / dist;

                // Current direction
                let currentDirX = vel.x;
                let currentDirZ = vel.z;
                const currentSpeed = Math.hypot(currentDirX, currentDirZ);

                if (currentSpeed > 0.1) {
                    currentDirX /= currentSpeed;
                    currentDirZ /= currentSpeed;

                    // Steer velocity vector towards target
                    // This eliminates the "orbiting" effect of force-based steering
                    const steerFactor = 5.0 * dt; // Strength of steering
                    
                    const newDirX = currentDirX + (dirX - currentDirX) * steerFactor;
                    const newDirZ = currentDirZ + (dirZ - currentDirZ) * steerFactor;
                    
                    // Renormalize
                    const newLen = Math.hypot(newDirX, newDirZ);
                    const finalDirX = newDirX / newLen;
                    const finalDirZ = newDirZ / newLen;

                    // Apply back to velocity, preserving speed (or slightly boosting/damping)
                    this.body.velocity.x = finalDirX * currentSpeed;
                    this.body.velocity.z = finalDirZ * currentSpeed;

                    // Update visual target yaw
                    this.targetYaw = Math.atan2(finalDirX, finalDirZ);
                }
            }

            // End of path check
            if (this.pathIndex >= this.pathPoints.length - 2) {
                this.pathFollowActive = false;
            }
        } else if (speed > 1) {
            // Not following path, just face movement
            this.targetYaw = Math.atan2(vel.x, vel.z);
        }

        // --- Gravity/Terrain assist ---
        // Push donut down slightly to grip terrain
        this.body.applyForce(new CANNON.Vec3(0, -20 * 50, 0), pos);

        // --- Visual Animation Update ---
        this.meshGroup.position.copy(pos);

        // 1. Roll (based on speed)
        // Rolling around local X
        this.rollAngle += (speed * dt) / 1.35;
        this.rollAngle %= (Math.PI * 2);

        // 2. Yaw (smooth turn)
        // Lerp angle to avoid 360 wrap issues
        this.visualYaw = lerpAngle(this.visualYaw, this.targetYaw, 5 * dt);

        // 3. Bank (tilt into turn)
        // Calculate turn rate
        let yawDiff = this.targetYaw - this.visualYaw;
        // wrap to -PI, PI
        yawDiff = Math.atan2(Math.sin(yawDiff), Math.cos(yawDiff));
        
        const maxBank = 0.6;
        const targetBank = THREE.MathUtils.clamp(yawDiff * 1.5, -maxBank, maxBank);
        this.currentBank = THREE.MathUtils.lerp(this.currentBank, targetBank, 5 * dt);

        // 4. Penny Wobble (Crash/Stop) logic
        let wobbleQuat = new THREE.Quaternion();
        
        if (speed < 5.0 && this.isRolling) {
            // As we get slow, start wobbling
            const wobbleFactor = Math.max(0, 1 - (speed / 5.0)); // 0 at speed 5, 1 at speed 0
            
            // Frequency increases as we slow down (the penny settling sound effect)
            this.wobbleSpeed += dt * (1 + wobbleFactor * 10);
            
            // Amplitude grows
            const wobbleAmp = wobbleFactor * 1.4; // up to ~80 degrees tilt
            
            // Sinusoidal wobble
            this.wobbleAngle = Math.sin(this.wobbleSpeed) * wobbleAmp;
            
            wobbleQuat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.wobbleAngle);

            // Check for "fallen" state
            if (speed < 0.5 && wobbleFactor > 0.9) {
                this.hasFallen = true;
            }
        }

        // --- Compose Quaternions ---
        // Order: Yaw (World Y) -> Bank (Local Z) -> Wobble (Local Z) -> Roll (Local X)
        // Actually Wobble and Bank interact. Let's just apply Wobble as an extra Z rotation.
        
        const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.visualYaw);
        const qBank = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -this.currentBank + this.wobbleAngle);
        const qRoll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.rollAngle);
        
        const finalQ = qYaw.clone().multiply(qBank).multiply(qRoll);
        this.meshGroup.quaternion.copy(finalQ);

        // --- Hide Limbs while rolling ---
        if (this.limbsGroup.visible) {
            this.limbsGroup.visible = false;
        }

        // --- Trail Update ---
        this.trail.update(this.meshGroup.position, this.meshGroup.quaternion);
    }

    getPosition() {
        return this.body.position;
    }

    resetPhysicsPosition() {
        this.body.position.copy(this.basePosition);
        this.body.velocity.set(0,0,0);
        this.body.angularVelocity.set(0,0,0);
        this.meshGroup.position.copy(this.basePosition);
    }
}