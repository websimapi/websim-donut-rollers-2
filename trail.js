import * as THREE from 'three';

export class Trail {
    constructor(scene, color = 0xffffff) {
        this.scene = scene;
        this.maxPoints = 80;
        this.width = 1.2;
        this.points = []; // { pos: Vector3, right: Vector3 }
        
        // Geometry for a strip of triangles
        // 2 vertices per point
        this.geometry = new THREE.BufferGeometry();
        
        // Attributes
        const positions = new Float32Array(this.maxPoints * 2 * 3);
        this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        
        const indices = [];
        for (let i = 0; i < this.maxPoints - 1; i++) {
            const k = i * 2;
            // Two triangles per segment
            indices.push(k, k + 1, k + 2);
            indices.push(k + 1, k + 3, k + 2);
        }
        this.geometry.setIndex(indices);
        
        const material = new THREE.MeshBasicMaterial({
            color: color,
            transparent: true,
            opacity: 0.6,
            side: THREE.DoubleSide,
            depthWrite: false, // Don't block other transparency
            blending: THREE.AdditiveBlending
        });
        
        this.mesh = new THREE.Mesh(this.geometry, material);
        this.mesh.frustumCulled = false;
        this.scene.add(this.mesh);
    }
    
    update(position, quaternion) {
        // Calculate the "right" vector based on orientation
        // Assuming the donut rolls along local Z or X? 
        // Based on donut.js: geometry.rotateY(Math.PI/2) and Cylinder orientation:
        // The axle is the local X axis.
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
        
        // Position at the bottom (contact patch approximation)
        // Donut radius is approx 1.45
        const contactPos = position.clone().sub(new THREE.Vector3(0, 1.3, 0));
        
        this.points.unshift({ pos: contactPos, right: right });
        
        if (this.points.length > this.maxPoints) {
            this.points.pop();
        }
        
        this.updateGeometry();
    }
    
    updateGeometry() {
        const posAttr = this.geometry.attributes.position;
        const arr = posAttr.array;
        
        for (let i = 0; i < this.points.length; i++) {
            const p = this.points[i];
            const scale = 1 - (i / this.points.length); // Fade out width
            const w = this.width * scale * 0.5; // Half width
            
            // Left vertex
            const l = p.pos.clone().add(p.right.clone().multiplyScalar(-w));
            // Right vertex
            const r = p.pos.clone().add(p.right.clone().multiplyScalar(w));
            
            // Lift slightly to avoid z-fighting with ground
            const lift = i * 0.01 + 0.1;
            
            arr[i*6 + 0] = l.x;
            arr[i*6 + 1] = l.y + lift;
            arr[i*6 + 2] = l.z;
            
            arr[i*6 + 3] = r.x;
            arr[i*6 + 4] = r.y + lift;
            arr[i*6 + 5] = r.z;
        }
        
        // Collapse remaining vertices to the last point to hide them
        if (this.points.length > 0) {
            const lastIdx = (this.points.length - 1) * 6;
            for (let i = this.points.length; i < this.maxPoints; i++) {
                for(let k=0; k<6; k++) {
                    arr[i*6 + k] = arr[lastIdx + k];
                }
            }
        }
        
        posAttr.needsUpdate = true;
    }
    
    reset() {
        this.points = [];
        this.updateGeometry();
    }
}