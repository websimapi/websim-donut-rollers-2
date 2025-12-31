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
        
        // Boost tracking - following swipe path
        this.boostActive = false;
        this.boostDirection = new CANNON.Vec3();
        this.boostMagnitude = 0;
        this.boostDuration = 0;
        this.boostElapsed = 0;
        
        // --- Visuals ---
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
        // Use a composite body:
        // 1. A Sphere for the main ground contact (Smoothest rolling behavior, no edge catching)
        // 2. A smaller Cylinder to represent the physical bounds if it falls over completely
        
        const sphereRadius = 1.45;
        const sphereShape = new CANNON.Sphere(sphereRadius);
        
        this.body = new CANNON.Body({
            mass: 50, // Slightly heavier for better momentum
            material: new CANNON.Material({ friction: 0.3, restitution: 0.0 }) // Lower friction to prevent sticking, we handle grip manually
        });
        
        // Add Sphere (Main roller)
        this.body.addShape(sphereShape, new CANNON.Vec3(0, 0, 0));

        // Add hidden Cylinder (for falling collision bounds)
        // Slightly smaller radius so it doesn't interfere with smooth rolling
        const cylRadius = 1.2;
        const cylWidth = 0.9;
        const cylinderShape = new CANNON.Cylinder(cylRadius, cylRadius, cylWidth, 16);
        const q = new CANNON.Quaternion();
        q.setFromAxisAngle(new CANNON.Vec3(0,0,1), -Math.PI / 2); // Align with X-axis
        this.body.addShape(cylinderShape, new CANNON.Vec3(0,0,0), q);

        this.body.position.copy(position);
        
        this.body.linearDamping = 0.5; // Heavy drag
        this.body.angularDamping = 0.5; // Heavy rotational drag
        
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
        this.trail.reset();
        
        this.meshGroup.rotation.set(0, 0, 0); 
        
        if (!isNaN(this.meshGroup.position.y)) {
            this.body.position.copy(this.meshGroup.position);
        } else {
            this.body.position.set(0, 10, 0);
        }
        
        this.world.addBody(this.body);
        // Initial "Peel out" spin
        this.body.velocity.set(0, 0, 5);
        this.body.angularVelocity.set(15, 0, 0); // High RPM start

        this.assets.playSound('jump');
        this.assets.playLoop('roll');
    }

    // New boost system - no cooldown, follows swipe path
    boostWithDirection(vx, vy) {
        if (!this.isRolling || this.isFlattening) return;
        
        console.log(`[Donut] Boost Input: vx=${vx.toFixed(3)}, vy=${vy.toFixed(3)}`);

        // Map screen space to world
        // Camera looks +Z. Screen Right (+vx) corresponds to World Left (-x) in this view.
        // Screen Up (-vy) corresponds to World Forward (+z).
        const inputDir = new CANNON.Vec3(-vx, 0, -vy);
        const strength = inputDir.length();
        
        if (strength < 0.1) {
             console.log(`[Donut] Boost ignored: too weak (${strength.toFixed(3)})`);
             return;
        }
        
        inputDir.normalize();
        console.log(`[Donut] Boost World Dir: ${inputDir.x.toFixed(2)}, ${inputDir.y.toFixed(2)}, ${inputDir.z.toFixed(2)}`);

        // Calculate boost based on swipe length
        const maxBoostDuration = 0.5; 
        const minBoostDuration = 0.1; 
        this.boostDuration = minBoostDuration + (strength * (maxBoostDuration - minBoostDuration));
        
        // Reduced boost power to prevent "way way too fast" speeds
        // Much lower boost power so swipes don't send us "way way too fast"
        const baseBoost = 3; 
        const maxBoost = 8; 
        this.boostMagnitude = baseBoost + (strength * (maxBoost - baseBoost));
        
        this.boostDirection.copy(inputDir);
        this.boostActive = true;
        this.boostElapsed = 0;
        
        // --- Strong Orientation Correction on Boost ---
        // Auto-align the physics velocity to the swipe direction
        const speed = this.body.velocity.length();
        if (speed > 1) {
            // Redirect current momentum partially to new direction
            const newVel = inputDir.clone().scale(speed);
            // Blend: 60% new direction, 40% old (Smooth turn but responsive)
            this.body.velocity.lerp(newVel, 0.6, this.body.velocity);
        }
        
        // Reset instability
        this.isUnstable = false;
        this.isFlattening = false;
        this.flattenFactor = 0;
        
        // Re-align the donut visually/physically to face the new direction immediately
        // Compute new rotation quaternion where local X (axle) is perpendicular to movement
        const moveDir = new THREE.Vector3(inputDir.x, 0, inputDir.z);
        const up = new THREE.Vector3(0, 1, 0);
        const newAxle = new THREE.Vector3().crossVectors(up, moveDir).normalize();
        
        // We can't snap physics instantly without glitches, but we can apply a strong torque impulse
        // to help the stabilizer in the update loop
        
        this.assets.playSound('jump');
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
                
                // If basically stopped, stay stopped
                if (speed < 0.5) {
                    this.body.angularVelocity.set(0,0,0);
                    this.body.velocity.set(0,0,0);
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
                const stabilityForce = 150 + (speed * 10);
                
                // Apply torque proportional to tilt
                const correctionTorque = correctionAxis.scale(tilt * stabilityForce);
                this.body.torque.vadd(correctionTorque, this.body.torque);

                // 2. WOBBLE DAMPING
                // Remove angular velocity that isn't along the axle (rolling) or global Y (turning)
                const omega = this.body.angularVelocity;
                const omegaAxle = axle.clone().scale(omega.dot(axle)); // Rolling spin
                const omegaWobble = omega.vsub(omegaAxle); // Everything else
                
                // Dampen the wobble strongly
                this.body.torque.vsub(omegaWobble.scale(50), this.body.torque);
                
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
                // Keeps the sphere grounded on slopes - softened to avoid "slamming" into bumps
                this.body.applyForce(new CANNON.Vec3(0, -40 * this.body.mass, 0), this.body.position);
            }

            // --- Velocity Clamping ---
            // Keep overall speed under control to avoid crazy launches from terrain bumps
            const vel = this.body.velocity;
            const speed = vel.length();
            const maxSpeed = 18;
            if (speed > maxSpeed) {
                const scale = maxSpeed / speed;
                vel.scale(scale, vel);
            }
            // Clamp vertical velocity so we don't rocket up/down from collisions
            if (vel.y > 12) vel.y = 12;
            if (vel.y < -35) vel.y = -35;

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
        if (!isNaN(this.meshGroup.position.y)) {
            this.body.position.copy(this.meshGroup.position);
            this.body.velocity.set(0,0,0);
            this.body.angularVelocity.set(0,0,0);
        }
    }
}