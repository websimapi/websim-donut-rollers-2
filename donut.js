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
        const radius = 1.45;
        const width = 0.9;
        
        const cylinderShape = new CANNON.Cylinder(radius, radius, width, 24);
        const q = new CANNON.Quaternion();
        q.setFromAxisAngle(new CANNON.Vec3(0,0,1), -Math.PI / 2);
        
        this.body = new CANNON.Body({
            mass: 40,
            material: new CANNON.Material({ friction: 0.8, restitution: 0.0 })
        });
        
        this.body.addShape(cylinderShape, new CANNON.Vec3(0,0,0), q);
        this.body.position.copy(position);
        
        this.body.linearDamping = 0.01;
        this.body.angularDamping = 0.4; // High damping to prevent spinning out
        this.body.ccdSpeedThreshold = 0.5;
        this.body.ccdIterations = 10;
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
        // Reduce initial speed
        this.body.velocity.set(0, 0, 15);
        this.body.angularVelocity.set(10, 0, 0);

        this.assets.playSound('jump');
        this.assets.playLoop('roll');
    }

    // New boost system - no cooldown, follows swipe path
    boostWithDirection(vx, vy) {
        if (!this.isRolling) return;
        
        // Map screen space to world (x: Right, -y (Up): Forward)
        const inputDir = new CANNON.Vec3(vx, 0, -vy);
        const strength = inputDir.length();
        
        // Minimum threshold for tap
        if (strength < 0.1) return;
        
        inputDir.normalize();

        // Calculate boost based on swipe length
        // Longer swipe = longer boost duration and stronger magnitude
        const maxBoostDuration = 0.8; // Max 0.8 seconds
        const minBoostDuration = 0.15; // Min for tap
        this.boostDuration = minBoostDuration + (strength * (maxBoostDuration - minBoostDuration));
        
        // Boost magnitude scales with swipe length
        const baseBoost = 15; // Small boost
        const maxBoost = 35; // Max boost for longest swipe
        this.boostMagnitude = baseBoost + (strength * (maxBoost - baseBoost));
        
        // Set boost direction
        this.boostDirection.copy(inputDir);
        
        // Activate boost
        this.boostActive = true;
        this.boostElapsed = 0;
        
        // Gentle orientation correction (not a snap)
        const currentDir = new THREE.Vector3(
            this.body.velocity.x,
            0,
            this.body.velocity.z
        ).normalize();
        
        // If we have existing velocity, blend with it
        if (currentDir.length() > 0.1) {
            const targetDir = new THREE.Vector3(inputDir.x, 0, inputDir.z);
            // Blend 30% new direction, 70% current
            currentDir.lerp(targetDir, 0.3).normalize();
            this.boostDirection.set(currentDir.x, 0, currentDir.z);
        }

        // Reset instability on boost
        this.isUnstable = false;
        this.isFlattening = false;
        this.flattenFactor = 0;
        
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
            // --- Trail Update ---
            this.trail.update(this.meshGroup.position, this.meshGroup.quaternion);

            // --- Downforce ---
            // Constant downforce to stick to terrain
            this.body.applyForce(new CANNON.Vec3(0, -60 * this.body.mass, 0), this.body.position);

            // --- Boost Logic ---
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

            // --- STRICT STABILITY CONTROL ---
            // Calculate the axle vector in world space
            const axle = new CANNON.Vec3(1, 0, 0);
            this.body.quaternion.vmult(axle, axle);
            
            // Prevent Tumble/Wobble
            // Decompose angular velocity
            const omega = this.body.angularVelocity;
            
            // Component along axle (Good - this is rolling)
            const omegaAxle = axle.clone().scale(omega.dot(axle));
            
            // Component perpendicular to axle (Bad - this is wobble/tumble)
            const omegaWobble = omega.vsub(omegaAxle);
            
            // Kill the wobble aggressively
            this.body.torque.vsub(omegaWobble.scale(300), this.body.torque);

            // --- Orientation Correction ---
            // Keep the axle flat (parallel to X-Z plane mostly)
            const up = new CANNON.Vec3(0, 1, 0);
            const tilt = axle.dot(up); // 0 is flat, 1 is vertical (fallen over)
            
            if (Math.abs(tilt) > 0.05) {
                // Apply torque to flatten axle
                const correctionAxis = new CANNON.Vec3();
                axle.cross(up, correctionAxis); // Vector pointing forward/back
                correctionAxis.normalize();
                
                // Strong correction torque
                const correctionTorque = correctionAxis.scale(tilt * 200);
                this.body.torque.vadd(correctionTorque, this.body.torque);
            }

            // --- Steering ---
            if (Math.abs(this.steeringInput) > 0.01) {
                const turnForce = 60;
                this.body.applyForce(
                    new CANNON.Vec3(this.steeringInput * turnForce, 0, 0),
                    this.body.position
                );
                
                // Bank into turn slightly (visual feel)
                const bankTorque = new CANNON.Vec3(0, 0, -this.steeringInput * 10);
                this.body.torque.vadd(bankTorque, this.body.torque);
            }

            // --- Sideways Friction (prevent sliding) ---
            const vel = this.body.velocity;
            const forwardDir = new CANNON.Vec3();
            axle.cross(up, forwardDir); // Roughly forward
            forwardDir.normalize();
            
            const forwardSpeed = vel.dot(forwardDir);
            const forwardVel = forwardDir.scale(forwardSpeed);
            const slideVel = vel.vsub(forwardVel);
            
            // Apply force against sliding
            this.body.applyForce(slideVel.scale(-10 * this.body.mass), this.body.position);

            // --- Speed Limit ---
            const speed = vel.length();
            const MAX_SPEED = 40; // Hard cap reduced
            if (speed > MAX_SPEED) {
                const scale = MAX_SPEED / speed;
                this.body.velocity.scale(scale, this.body.velocity);
            }

            // --- Sync Visuals ---
            if (!isNaN(this.body.position.x)) {
                this.meshGroup.position.copy(this.body.position);
                this.meshGroup.quaternion.copy(this.body.quaternion);
            }

            // Hide limbs during roll
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