# Use an official Python runtime as a parent image
FROM python:3.11-slim

# Set the working directory in the container
WORKDIR /app

# Install system dependencies (like gcc) needed to compile some python packages
RUN apt-get update && apt-get install -y gcc && rm -rf /var/lib/apt/lists/*

# Copy the requirements file into the container
COPY requirements.txt .

# Install the dependencies
RUN pip install --no-cache-dir -r requirements.txt

# We also need gunicorn to serve the Flask app in production
RUN pip install gunicorn

# Copy the rest of the backend code into the container
COPY . .

# Render requires the app to listen on port 10000
EXPOSE 10000

# Run the application using Gunicorn
CMD ["gunicorn", "--bind", "0.0.0.0:10000", "app:app"]