
async function joinRoom() {

    const username = document
        .getElementById("username")
        .value.trim();

    const room = document
        .getElementById("room")
        .value.trim();

    const message = document.getElementById("message");

    message.textContent = "";

    if (!username || !room) {
        message.textContent = "Wypełnij wszystkie pola.";
        return;
    }

    try {

        const response = await fetch(
            "http://127.0.0.1:8000/api/token",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    name: username,
                    room: room
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || "Nie udało się dołączyć.");
        }

        // Zapis danych połączenia na czas przejścia do pokoju
        sessionStorage.setItem(
            "videochat_connection",
            JSON.stringify(data)
        );

        window.location.href =
            "room.html?room=" + encodeURIComponent(room);

    } catch (error) {

        message.textContent = error.message;

    }
}

