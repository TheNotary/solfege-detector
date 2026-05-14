import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import type {Resource} from '../types/Resource';
import AppConfig from '../AppConfig';
import { useError } from "../context/ErrorContext";

export default function ResourceDetail() {
    const { setError } = useError();
    const { id } = useParams();
    const navigate = useNavigate();

    const [resource, setResource] = useState<Resource | null>(null);

    useEffect(() => {
        axios
          .get(`${AppConfig.BACKEND_URL}/api/articles/${id}`)
          .then(response => {
              setResource(response.data);
          })
          .catch(err => {
              const msg = 'Failed to get resource';
              console.error(msg, err);
              setError(`error: ${msg}. ${err.code} - ${err.message}`);
          });
    }, [id]);

    const handleDelete = async () => {
        await axios
            .delete(`${AppConfig.BACKEND_URL}/api/articles/${id}`)
            .then(() => {
                navigate('/resources');
            })
            .catch(err => {
                const msg = 'Failed to delete resource';
                console.error(msg, err);
                setError(`error: ${msg}. ${err.code} - ${err.message}`);
            });
    };

    if (!resource) return <p>Loading...</p>;

    return (
        <div>
            <h2>Resource Detail</h2>
            <div>{resource.name}</div>
            <button onClick={handleDelete}>Delete</button>
        </div>
    );
}
