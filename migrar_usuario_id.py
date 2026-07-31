"""
Migración: agrega la columna usuario_id a la tabla ventas si no existe.
Correr UNA VEZ desde la carpeta del proyecto (donde está pos.db):
    python migrar_usuario_id.py
"""
import sqlite3

conn = sqlite3.connect("pos.db")
cur = conn.cursor()

cur.execute("PRAGMA table_info(ventas)")
columnas = [fila[1] for fila in cur.fetchall()]

if "usuario_id" in columnas:
    print("La columna usuario_id ya existe. No se hizo ningún cambio.")
else:
    cur.execute("ALTER TABLE ventas ADD COLUMN usuario_id INTEGER REFERENCES usuarios(id)")
    conn.commit()
    print("Columna usuario_id agregada correctamente a la tabla ventas.")

conn.close()
