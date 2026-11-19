
import os
import uuid
import re

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from livekit import api
from fastapi.middleware.cors import CORSMiddleware

# Wczytanie ustawień z pliku .env
load_dotenv()

app = FastAPI(title="VideoChat API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5500"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class JoinRequest(BaseModel):
    room: str = Field(min_length=3, max_length=50)
    name: str = Field(min_length=1, max_length=40)


@app.get("/")
def home():
    return {
        "message": "VideoChat API działa!"
    }


@app.post("/api/token")
def create_token(data: JoinRequest):

    # Sprawdzenie nazwy pokoju
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", data.room):
        raise HTTPException(
            status_code=400,
            detail="Nieprawidłowa nazwa pokoju"
        )

    api_key = os.getenv("LIVEKIT_API_KEY")
    api_secret = os.getenv("LIVEKIT_API_SECRET")
    server_url = os.getenv("LIVEKIT_URL")

    if not api_key or not api_secret or not server_url:
        raise HTTPException(
            status_code=500,
            detail="Brak konfiguracji LiveKit"
        )

    # Unikalny identyfikator uczestnika
    identity = str(uuid.uuid4())

    # Generowanie tokenu
    token = (
        api.AccessToken(api_key, api_secret)
        .with_identity(identity)
        .with_name(data.name)
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=data.room,
                can_publish=True,
                can_subscribe=True
            )
        )
        .to_jwt()
    )

    return {
        "server_url": server_url,
        "token": token,
        "room": data.room,
        "name": data.name
    }

