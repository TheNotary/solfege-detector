import { useEffect, useState } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import type { Resource } from '../types/Resource';
import AppConfig from '../AppConfig';
import { useError } from "../context/ErrorContext";

export default function ResourceList() {
    const { setError } = useError();
    const [resources, setResources] = useState<Resource[]>([]);

    useEffect(() => {
        fetchResources();
    }, []);

    const fetchResources = () => {
        axios
            .get<Resource[]>(`${AppConfig.BACKEND_URL}/api/articles`)
            .then(response => {
                setResources(response.data);
            })
            .catch(err => {
                const msg = 'Failed to fetch resource';
                console.error(msg, err);
                setError(`error: ${msg}. ${err.code} - ${err.message}`);
            });
    };

    const handleCreate = async () => {
        await axios
            .post(`${AppConfig.BACKEND_URL}/api/articles`,
                  { id: 0, name: 'New resource', price: 0.01 }
            )
            .then(() => {
                fetchResources(); // Refresh list after creating
            })
            .catch(err => {
                const msg = 'Failed to create resource';
                console.error(msg, err);
                setError(`error: ${msg}. ${err.code} - ${err.message}`);
            });
    };

    return (
        <div>
            <h2>Resources</h2>
            <button onClick={handleCreate}>Create</button>
            <ul>
                {resources.map((res, idx) => (
                    <li key={idx}>
                        <Link to={`/resources/${res.id}`}>{res.id} - {res.name}</Link>
                    </li>
                ))}
            </ul>
        </div>
    );
}
